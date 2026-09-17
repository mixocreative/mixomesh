/**
 * 3MF Mesh Fix Library v3.2 (WASM)
 *
 * 汎用メッシュ修復ライブラリ — WebAssembly版
 *
 * 機能:
 * - 頂点マージ（重複頂点の統合）
 * - 縮退三角形の除去（ゼロ面積含む）
 * - 反対巻き重複面の除去（内部壁の検出・除去）
 * - 完全重複三角形の除去（巻き方向一致のみ）
 * - 法線整合性の確保（BFS + 符号付き体積テスト）
 * - 非多様体エッジの修正（スコアリングベース）
 * - 非多様体頂点の修正（ファン分離）
 * - 穴埋め（イヤークリッピング三角形分割）
 * - 自己交差修復（BVH + 局所リメッシュ）
 * - Deep Repair（SDF + Marching Cubes ボクセル再構築）
 *
 * 依存: JSZip (3MFファイル処理用)
 *
 * 使用例:
 * ```javascript
 * const meshFix = new MeshFixLib();
 * await meshFix.init(); // WASMモジュールをロード
 *
 * // ArrayBufferから3MFを解析
 * const parsed = await meshFix.parse3MF(arrayBuffer);
 *
 * // 修復実行
 * const repaired = await meshFix.repairAll(parsed.objects, (progress) => {
 *   console.log(progress.status);
 * });
 *
 * // 3MFファイルを生成
 * const blob = await meshFix.write3MF(repaired.objects, parsed.originalXml, parsed.zip, parsed.modelPath);
 * ```
 */

class MeshFixLib {
  constructor() {
    this.VERSION = '3.2.0-wasm';
    this._wasmModule = null;
    this._lastRepairData = null;
  }

  /**
   * WASMモジュールをロード。修復・診断の前に呼び出す。
   * 複数回呼んでも安全（初回のみロード）。
   */
  async init() {
    if (this._wasmModule) return;

    let factory = typeof MeshFixCore !== 'undefined' ? MeshFixCore : undefined;

    // Workerコンテキスト: importScriptsでロード
    if (!factory && typeof importScripts === 'function') {
      try {
        importScripts('./build/mesh-fix-core.js');
      } catch (e) {
        importScripts('./mesh-fix-core.js');
      }
      factory = typeof MeshFixCore !== 'undefined' ? MeshFixCore : undefined;
    }

    // Node.jsコンテキスト: requireでロード
    if (!factory && typeof require === 'function') {
      try {
        factory = require('./build/mesh-fix-core.js');
      } catch (e) {
        try {
          factory = require('./mesh-fix-core.js');
        } catch (e2) {
          // fall through
        }
      }
    }

    if (!factory) {
      throw new Error('MeshFixCore not found. Ensure mesh-fix-core.js is loaded.');
    }

    this._wasmModule = await factory();
  }

  /**
   * メモリ解放。修復完了・エクスポート後に呼び出す。
   */
  dispose() {
    this._lastRepairData = null;
  }

  static defaultOptions() {
    return {
      mergePrecision: 'auto',
      degenerateThreshold: 'auto',
      holeAreaMultiplier: 'auto',
      localRemeshLimit: 0.3,
      edgeFlipPasses: 20,
      nmEdgeIterations: 50,
      oversizeMultiplier: 20,
      assumeClosedSolid: 'auto',
      removeSmallShells: false,
      smallShellThreshold: 0.01,
      repairSelfIntersections: false,
      deepRepair: false,
      voxelResolution: 'auto',
      voxelSmoothing: true,
      voxelSmoothIterations: 3,
      voxelSmoothLambda: 0.5,
      voxelProjectToSurface: true,
      voxelProjectMaxDist: 'auto',
    };
  }

  // ===== 3MF パース/書き出し (JSZip依存のためJS側に残す) =====

  async parse3MF(buffer) {
    if (typeof JSZip === 'undefined') {
      throw new Error('JSZip is required. Please include JSZip library.');
    }

    const zip = await JSZip.loadAsync(buffer);

    const mainModelPath = Object.keys(zip.files).find(f =>
      f.toLowerCase().includes('3dmodel.model') && !f.toLowerCase().includes('objects/')
    );

    if (!mainModelPath) {
      throw new Error('3D model file not found in 3MF archive');
    }

    const mainXml = await zip.file(mainModelPath).async('text');
    let objects = this._parseObjects(mainXml);

    if (objects.length === 0) {
      const modelFiles = Object.keys(zip.files).filter(f =>
        f.toLowerCase().endsWith('.model') && f !== mainModelPath
      );

      for (const modelFile of modelFiles) {
        const xml = await zip.file(modelFile).async('text');
        const fileObjects = this._parseObjects(xml);
        for (const obj of fileObjects) {
          obj._sourcePath = modelFile;
          objects.push(obj);
        }
      }
    }

    const allModelPaths = Object.keys(zip.files).filter(f =>
      f.toLowerCase().endsWith('.model')
    );

    return {
      objects,
      originalXml: mainXml,
      zip,
      modelPath: mainModelPath,
      allModelPaths,
      isMultiFile: objects.length > 0 && objects[0]._sourcePath !== undefined
    };
  }

  _parseObjects(xml) {
    const objects = [];
    const objRe = /<object\s+id="(\d+)"[^>]*>[\s\S]*?<mesh>([\s\S]*?)<\/mesh>[\s\S]*?<\/object>/gi;
    let m;

    while ((m = objRe.exec(xml)) !== null) {
      const id = m[1];
      const meshContent = m[2];

      const V = [];
      const T = [];

      const vRe = /<vertex\s+x="([^"]+)"\s+y="([^"]+)"\s+z="([^"]+)"/gi;
      let vm;
      while ((vm = vRe.exec(meshContent)) !== null) {
        V.push([+vm[1], +vm[2], +vm[3]]);
      }

      const tRe = /<triangle\s+v1="(\d+)"\s+v2="(\d+)"\s+v3="(\d+)"/gi;
      let tm;
      while ((tm = tRe.exec(meshContent)) !== null) {
        T.push([+tm[1], +tm[2], +tm[3]]);
      }

      if (V.length > 0) {
        objects.push({ id, V, T });
      }
    }

    return objects;
  }

  // ===== 診断 (WASM) =====

  diagnose(V, T) {
    if (!this._wasmModule) {
      throw new Error('WASM module not initialized. Call init() first.');
    }
    return this._wasmModule.diagnose(V, T);
  }

  // ===== Phase 10-A1: 軽量クリーンアップ (JS側・WASM呼び出し前の前処理) =====
  // 1e-5未満の重複頂点をマージし、2つ以上のインデックスが一致する縮退三角形を破棄する。
  // WASMが扱う頂点・三角形数を削減してWASM時間を短縮するためのヘルパー。
  // @param {Array<Array<number>>} V 頂点配列 [[x,y,z], ...]
  // @param {Array<Array<number>>} T 三角形配列 [[a,b,c], ...]
  // @returns {{V: Array, T: Array, removed: {duplicateVerts: number, degenerateTris: number}}}
  static lightCleanup(V, T) {
    if (!V || !T) return { V: V || [], T: T || [], removed: { duplicateVerts: 0, degenerateTris: 0 } };

    // 重複頂点マージ (1e-5精度)
    const map = new Map();
    const newV = [];
    const remap = new Array(V.length);
    for (let i = 0; i < V.length; i++) {
      const v = V[i];
      const key = v[0].toFixed(5) + '|' + v[1].toFixed(5) + '|' + v[2].toFixed(5);
      if (map.has(key)) {
        remap[i] = map.get(key);
      } else {
        const newIdx = newV.length;
        map.set(key, newIdx);
        remap[i] = newIdx;
        newV.push([v[0], v[1], v[2]]);
      }
    }
    const duplicateVerts = V.length - newV.length;

    // 縮退三角形を捨てつつ remap 適用
    const newT = [];
    let degenerateTris = 0;
    for (let i = 0; i < T.length; i++) {
      const t = T[i];
      const a = remap[t[0]];
      const b = remap[t[1]];
      const c = remap[t[2]];
      if (a === b || b === c || a === c) {
        degenerateTris++;
        continue;
      }
      newT.push([a, b, c]);
    }

    return { V: newV, T: newT, removed: { duplicateVerts, degenerateTris } };
  }

  // ===== Phase 10-A3: 修復ステージ情報 (UIの進捗表示用) =====
  // 各 id は WASM 内の主要パスに対応。ラベルは UI の「現在のフェーズ」表示に流用できる。
  static STAGES = Object.freeze([
    { id: 'merge_vertices',    label: '重複頂点統合' },
    { id: 'remove_degenerate', label: '縮退三角形削除' },
    { id: 'fix_normals',       label: '法線方向修正' },
    { id: 'fill_holes',        label: '穴埋め' },
    { id: 'voxel_remesh',      label: 'ボクセルリメッシュ (任意)' }
  ]);

  // ===== Phase 10-A4: 修復失敗時の代替オプション enum =====
  // 呼び出し側 (UI) は repair が失敗したとき、これらの選択肢をユーザーに提示すべき。
  // - raw:           修復をスキップして入力をそのまま出力
  // - light:         lightCleanup() のみ適用 (WASM不要)
  // - diagnose_only: diagnose() の結果だけを表示し、エクスポートしない
  // - abort:         処理を完全に中止
  static FALLBACK_OPTIONS = Object.freeze({
    raw: '修復なしで出力',
    light: '軽量修復のみ',
    diagnose_only: '診断結果のみ表示',
    abort: 'キャンセル'
  });

  // ===== Phase 10-A5: 3MF メタデータ検証 =====
  // write3MF 後の生成物（または既存 modelXml）が最低限の構造要素を持つかを検査する。
  // @param {JSZip|null} zipObject - 任意。指定されれば中身ファイル数も報告。
  // @param {string} modelXml - 3dmodel.model の XML 文字列
  // @returns {{ ok: boolean, issues: string[], objectCount: number, fileCount: number }}
  static validate3MFContent(zipObject, modelXml) {
    const issues = [];
    const xml = (typeof modelXml === 'string') ? modelXml : '';

    // 必須構造要素
    const hasResources = /<resources[\s>]/i.test(xml);
    const hasBuild     = /<build[\s>]/i.test(xml);
    const objectMatches = xml.match(/<object\s+id="[^"]+"/gi) || [];
    const objectCount = objectMatches.length;

    if (!hasResources) issues.push('<resources> 要素が見つからない');
    if (!hasBuild)     issues.push('<build> 要素が見つからない');
    if (objectCount === 0) issues.push('<object id="..."> が1つも見つからない');

    // AMS / マテリアル参照は厳密スキーマ確定が困難なので、出現件数のみ報告する
    const buildItemMatches = xml.match(/<item\s+objectid="[^"]+"/gi) || [];
    if (buildItemMatches.length === 0 && hasBuild) {
      issues.push('<build> に <item objectid="..."> が無い');
    }
    if (buildItemMatches.length !== objectCount && objectCount > 0) {
      // 必ずしもエラーではないが警告として残す
      issues.push(`build の item 数 (${buildItemMatches.length}) と object 数 (${objectCount}) が不一致`);
    }

    let fileCount = 0;
    try {
      if (zipObject && zipObject.files) {
        fileCount = Object.keys(zipObject.files).length;
      }
    } catch (e) { /* ignore */ }

    return {
      ok: issues.length === 0,
      issues,
      objectCount,
      fileCount,
      buildItemCount: buildItemMatches.length
    };
  }

  // ===== Phase 5-3: 修復プロファイル =====
  // ユースケースごとに事前定義されたオプションセットを返す。
  // - fast:           軽量メッシュ用、クリティカルな修復のみ
  // - standard:       通常用途、既定値（v1.0 動作互換）
  // - detail:         細部を保持しつつ修復（テキスト刻印など細い形状向け）
  // - strong:         強力修復、形状を多少崩しても確実に閉じる
  // - slicer-compat:  Bambu / Orca で確実に読めるよう保守的設定
  static REPAIR_PROFILES = Object.freeze({
    fast: {
      mergeVertexEpsilon: 0.001,
      removeDegenerate: true,
      fixWinding: false,
      fillHoles: false,
      removeIsolated: true
    },
    standard: {
      mergeVertexEpsilon: 0.0005,
      removeDegenerate: true,
      fixWinding: true,
      fillHoles: true,
      removeIsolated: true
    },
    detail: {
      mergeVertexEpsilon: 0.0001,  // 細かい点を統合しすぎない
      removeDegenerate: true,
      fixWinding: true,
      fillHoles: true,
      removeIsolated: false,        // 小さなパーツも保持
      preserveSharpEdges: true
    },
    strong: {
      mergeVertexEpsilon: 0.002,
      removeDegenerate: true,
      fixWinding: true,
      fillHoles: true,
      fillHolesAggressive: true,
      removeIsolated: true,
      voxelRemesh: true
    },
    'slicer-compat': {
      mergeVertexEpsilon: 0.0005,
      removeDegenerate: true,
      fixWinding: true,
      fillHoles: true,
      removeIsolated: true,
      ensureWatertight: true,
      ensureManifold: true
    }
  });

  // 名前指定でプロファイルを取得（不明なら standard）
  static getRepairProfile(name) {
    return MeshFixLib.REPAIR_PROFILES[name] || MeshFixLib.REPAIR_PROFILES.standard;
  }

  // ===== Phase 5-2: 修復前後レポート =====
  // diagnose の結果を比較しやすい形に整える
  buildRepairReport(beforeDiag, afterDiag, before, after, repairReport) {
    const safe = (d, k, def) => (d && d[k] != null) ? d[k] : def;
    return {
      before: {
        vertices: before ? before.V.length : 0,
        triangles: before ? before.T.length : 0,
        boundary: safe(beforeDiag, 'boundary', 0),
        nonManifold: safe(beforeDiag, 'nonManifold', 0),
        holes: safe(beforeDiag, 'holes', 0),
        shells: safe(beforeDiag, 'shells', 1),
        watertight: !!safe(beforeDiag, 'isWatertight', false),
        manifold: !!safe(beforeDiag, 'isManifold', false)
      },
      after: {
        vertices: after ? after.V.length : 0,
        triangles: after ? after.T.length : 0,
        boundary: safe(afterDiag, 'boundary', 0),
        nonManifold: safe(afterDiag, 'nonManifold', 0),
        holes: safe(afterDiag, 'holes', 0),
        shells: safe(afterDiag, 'shells', 1),
        watertight: !!safe(afterDiag, 'isWatertight', false),
        manifold: !!safe(afterDiag, 'isManifold', false)
      },
      delta: {
        vertices: (after ? after.V.length : 0) - (before ? before.V.length : 0),
        triangles: (after ? after.T.length : 0) - (before ? before.T.length : 0),
        merged: safe(repairReport, 'merged', 0),
        nmFixed: safe(repairReport, 'nmFixed', 0),
        holesFilled: safe(repairReport, 'holesFilled', 0)
      },
      summary: this._summarizeRepair(beforeDiag, afterDiag)
    };
  }

  _summarizeRepair(before, after) {
    const issues = [];
    const fixes = [];
    if (before && after) {
      if (before.boundary > 0 && after.boundary === 0) fixes.push('境界エッジを閉じた');
      if (before.nonManifold > 0 && after.nonManifold === 0) fixes.push('非多様体エッジを解消');
      if (before.holes > 0 && after.holes === 0) fixes.push(`穴を ${before.holes} 個埋めた`);
      if (after.boundary > 0) issues.push(`境界エッジ ${after.boundary} が残存`);
      if (after.nonManifold > 0) issues.push(`非多様体 ${after.nonManifold} が残存`);
      if (after.holes > 0) issues.push(`穴 ${after.holes} が残存`);
    }
    return { fixes, issues };
  }

  // ===== 修復 (WASM) =====

  /**
   * オブジェクト1つを修復する。
   * @param {Array} V 頂点配列
   * @param {Array} T 三角形配列
   * @param {Function|null} onProgress 進捗コールバック
   * @param {Object|string|null} userOptions プロファイル名または explicit option
   * @param {Object} [extra] - { signal?: AbortSignal-like }
   *   signal.aborted が true なら Error('Cancelled') をスローする。
   *   Phase 10-A2 注: WASM呼び出しはアトミックなので、中断は WASM の前後でのみ可能。
   *   実行中の WASM ステップを途中で止めることはできない。
   */
  async repairObject(V, T, onProgress = null, userOptions = null, extra = null) {
    if (!this._wasmModule) {
      throw new Error('WASM module not initialized. Call init() first.');
    }

    const signal = extra && extra.signal ? extra.signal : null;
    const checkAbort = () => {
      if (signal && signal.aborted) throw new Error('Cancelled');
    };
    checkAbort();

    // userOptions が文字列 (プロファイル名) なら展開
    let opts;
    if (typeof userOptions === 'string') {
      opts = MeshFixLib.getRepairProfile(userOptions);
    } else {
      opts = userOptions || {};
    }
    const progressFn = onProgress || undefined;

    // Phase 5-2: 修復前 diagnose を取得（レポート用）
    let beforeDiag = null;
    try { beforeDiag = this._wasmModule.diagnose(V, T); } catch (e) { /* ignore */ }

    checkAbort(); // WASM 呼び出し直前の最終チェック

    const result = this._wasmModule.repairObject(V, T, progressFn, opts);

    checkAbort(); // WASM 終了直後 (結果は破棄される)

    this._lastRepairData = { V: result.V, T: result.T };

    // Phase 5-2: 修復後 diagnose も取得し、レポートを組み立てる
    let afterDiag = null;
    try { afterDiag = this._wasmModule.diagnose(result.V, result.T); } catch (e) { /* ignore */ }
    const fullReport = this.buildRepairReport(beforeDiag, afterDiag, { V, T }, { V: result.V, T: result.T }, result.report);

    // Phase 10-A6: 変更領域の近似アノテーション
    // 入力頂点位置の集合 (5桁丸めキー) と出力の集合を比較し、
    // 「after にしか無い頂点」「before にしか無い頂点」を列挙する。
    // re-meshing 等では全頂点が変わるため近似でしかない。
    fullReport.changedRegions = MeshFixLib._computeChangedRegions(V, result.V);

    return {
      V: result.V,
      T: result.T,
      report: result.report,
      fullReport,
      diagnose: { before: beforeDiag, after: afterDiag }
    };
  }

  // Phase 10-A6: hash された頂点位置を比較して changedRegions を作る
  // 5桁の固定小数キーを使って Set ベースで集合差分を取る軽量近似。
  static _computeChangedRegions(beforeV, afterV) {
    try {
      const keyOf = (v) => v[0].toFixed(5) + '|' + v[1].toFixed(5) + '|' + v[2].toFixed(5);
      const beforeKeys = new Map();
      for (let i = 0; i < beforeV.length; i++) beforeKeys.set(keyOf(beforeV[i]), i);
      const afterKeys = new Map();
      for (let i = 0; i < afterV.length; i++) afterKeys.set(keyOf(afterV[i]), i);

      const addedVertexIndices = [];
      for (const [k, idx] of afterKeys) {
        if (!beforeKeys.has(k)) addedVertexIndices.push(idx);
      }
      const removedVertexIndices = [];
      for (const [k, idx] of beforeKeys) {
        if (!afterKeys.has(k)) removedVertexIndices.push(idx);
      }
      return { addedVertexIndices, removedVertexIndices };
    } catch (e) {
      return { addedVertexIndices: [], removedVertexIndices: [] };
    }
  }

  // ===== 一括修復 =====

  async repairAll(objects, onProgress = null, userOptions = null) {
    const results = [];
    const totalReport = { merged: 0, nmFixed: 0, holesFilled: 0 };

    for (let i = 0; i < objects.length; i++) {
      const obj = objects[i];

      if (onProgress) {
        onProgress({
          type: 'start',
          objectIndex: i,
          objectId: obj.id,
          total: objects.length,
          status: `Object ${obj.id} を処理中...`
        });
      }

      const result = await this.repairObject(obj.V, obj.T, (status) => {
        if (onProgress) {
          onProgress({
            type: 'progress',
            objectIndex: i,
            objectId: obj.id,
            total: objects.length,
            status
          });
        }
      }, userOptions);

      totalReport.merged += result.report.merged;
      totalReport.nmFixed += result.report.nmFixed;
      totalReport.holesFilled += result.report.holesFilled;

      const diagnosis = this.diagnose(result.V, result.T);

      const repaired = {
        id: obj.id,
        V: result.V,
        T: result.T,
        report: result.report,
        diagnosis
      };
      if (obj._sourcePath) repaired._sourcePath = obj._sourcePath;
      results.push(repaired);

      if (onProgress) {
        onProgress({
          type: 'done',
          objectIndex: i,
          objectId: obj.id,
          total: objects.length,
          report: result.report,
          diagnosis,
          status: diagnosis.isWatertight ? '水密' : `境界${diagnosis.boundary}`
        });
      }
    }

    return { objects: results, totalReport };
  }

  // ===== 3MF書き出し (JSZip依存のためJS側に残す) =====

  async write3MF(objects, originalXml, originalZip, modelPath, parsed = null) {
    const xmlByPath = new Map();

    for (let oi = 0; oi < objects.length; oi++) {
      const obj = objects[oi];
      const sourcePath = obj._sourcePath || modelPath;

      if (!xmlByPath.has(sourcePath)) {
        const xml = await originalZip.file(sourcePath).async('text');
        xmlByPath.set(sourcePath, xml);
      }

      const vLines = [];
      for (let i = 0; i < obj.V.length; i++) {
        const [x, y, z] = obj.V[i];
        vLines.push(`<vertex x="${x}" y="${y}" z="${z}"/>`);
      }

      const tLines = [];
      for (let i = 0; i < obj.T.length; i++) {
        const [a, b, c] = obj.T[i];
        tLines.push(`<triangle v1="${a}" v2="${b}" v3="${c}"/>`);
      }

      const newMeshContent = `<vertices>\n${vLines.join('\n')}\n</vertices>\n<triangles>\n${tLines.join('\n')}\n</triangles>`;

      const pattern = new RegExp(
        `(<object\\s+id="${obj.id}"[^>]*>[\\s\\S]*?<mesh>)[\\s\\S]*?(<\\/mesh>[\\s\\S]*?<\\/object>)`,
        'i'
      );

      const currentXml = xmlByPath.get(sourcePath);
      xmlByPath.set(sourcePath, currentXml.replace(pattern, `$1\n${newMeshContent}\n$2`));
    }

    const newZip = new JSZip();

    for (const path of Object.keys(originalZip.files)) {
      const file = originalZip.files[path];
      if (file.dir) {
        newZip.folder(path);
      } else if (xmlByPath.has(path)) {
        newZip.file(path, xmlByPath.get(path));
      } else {
        const content = await file.async('arraybuffer');
        newZip.file(path, content);
      }
    }

    return newZip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  }

  async create3MF(objects) {
    let objectsXml = '';
    let buildXml = '';

    for (let oi = 0; oi < objects.length; oi++) {
      const obj = objects[oi];

      const vLines = [];
      for (let i = 0; i < obj.V.length; i++) {
        const [x, y, z] = obj.V[i];
        vLines.push(`        <vertex x="${x}" y="${y}" z="${z}"/>`);
      }

      const tLines = [];
      for (let i = 0; i < obj.T.length; i++) {
        const [a, b, c] = obj.T[i];
        tLines.push(`        <triangle v1="${a}" v2="${b}" v3="${c}"/>`);
      }

      objectsXml += `  <object id="${obj.id}" type="model">
    <mesh>
      <vertices>
${vLines.join('\n')}
      </vertices>
      <triangles>
${tLines.join('\n')}
      </triangles>
    </mesh>
  </object>\n`;

      buildXml += `  <item objectid="${obj.id}"/>\n`;
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
<resources>
${objectsXml}</resources>
<build>
${buildXml}</build>
</model>`;

    const zip = new JSZip();
    zip.file('3D/3dmodel.model', xml);
    zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>');
    zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>');

    return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  }

  // ===== 単体メッシュ操作（3MFなし） =====

  async repairMesh(vertices, triangles, onProgress = null) {
    const result = await this.repairObject(vertices, triangles, onProgress);
    const diagnosis = this.diagnose(result.V, result.T);

    return {
      vertices: result.V,
      triangles: result.T,
      report: result.report,
      diagnosis
    };
  }
}

// ESModule / CommonJS / Browser グローバル対応
if (typeof module !== 'undefined' && module.exports) {
  module.exports = MeshFixLib;
} else if (typeof window !== 'undefined') {
  window.MeshFixLib = MeshFixLib;
}

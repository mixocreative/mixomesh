/* @ts-self-types="./mixo_geometry_wasm.d.ts" */

export class AsciiStlSession {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        AsciiStlSessionFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_asciistlsession_free(ptr, 0);
    }
    /**
     * @returns {WeldResult}
     */
    finish() {
        const ret = wasm.asciistlsession_finish(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return WeldResult.__wrap(ret[0]);
    }
    /**
     * @param {number} file_size
     */
    constructor(file_size) {
        const ret = wasm.asciistlsession_new(file_size);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        AsciiStlSessionFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @param {Uint8Array} chunk
     */
    push(chunk) {
        const ptr0 = passArray8ToWasm0(chunk, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.asciistlsession_push(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
}
if (Symbol.dispose) AsciiStlSession.prototype[Symbol.dispose] = AsciiStlSession.prototype.free;

export class BinaryStlSession {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        BinaryStlSessionFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_binarystlsession_free(ptr, 0);
    }
    /**
     * @returns {WeldResult}
     */
    finish() {
        const ret = wasm.binarystlsession_finish(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return WeldResult.__wrap(ret[0]);
    }
    /**
     * @param {number} triangles
     */
    constructor(triangles) {
        const ret = wasm.binarystlsession_new(triangles);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        BinaryStlSessionFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @param {Uint8Array} chunk
     */
    push(chunk) {
        const ptr0 = passArray8ToWasm0(chunk, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.binarystlsession_push(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
}
if (Symbol.dispose) BinaryStlSession.prototype[Symbol.dispose] = BinaryStlSession.prototype.free;

export class BodySegmentsResult {
    static __wrap(ptr) {
        const obj = Object.create(BodySegmentsResult.prototype);
        obj.__wbg_ptr = ptr;
        BodySegmentsResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        BodySegmentsResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_bodysegmentsresult_free(ptr, 0);
    }
    /**
     * @returns {Uint32Array}
     */
    take_first() {
        const ret = wasm.bodysegmentsresult_take_first(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint32Array}
     */
    take_keys() {
        const ret = wasm.bodysegmentsresult_take_keys(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    take_points() {
        const ret = wasm.bodysegmentsresult_take_points(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
}
if (Symbol.dispose) BodySegmentsResult.prototype[Symbol.dispose] = BodySegmentsResult.prototype.free;

/**
 * Step 1 result. Failed: `status() == 1` with `reason()`. Oriented: `status() == 0`.
 */
export class DentalOrientResult {
    static __wrap(ptr) {
        const obj = Object.create(DentalOrientResult.prototype);
        obj.__wbg_ptr = ptr;
        DentalOrientResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        DentalOrientResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_dentalorientresult_free(ptr, 0);
    }
    /**
     * confidence, terminal area ratio, axial variance ratio.
     * @returns {Float64Array}
     */
    diagnostics() {
        const ret = wasm.dentalorientresult_diagnostics(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * False when the opening found contradicts the profile's expectation (Step 1 mismatch notice).
     * @returns {boolean}
     */
    matches_profile() {
        const ret = wasm.dentalorientresult_matches_profile(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {boolean}
     */
    mesh_ok() {
        const ret = wasm.dentalorientresult_mesh_ok(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * 0 present, 1 absent, 2 ambiguous.
     * @returns {number}
     */
    opening() {
        const ret = wasm.dentalorientresult_opening(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Failure reason, or why the central opening is ambiguous (empty otherwise).
     * @returns {string}
     */
    reason() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.dentalorientresult_reason(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * kind (0 lower-edge loop, 1 projection fallback), opening direction, centroid, tangent,
     * bitangent (3 each), visibility resolution, visibility min (2), visibility max (2).
     * @returns {Float64Array}
     */
    rim_scalars() {
        const ret = wasm.dentalorientresult_rim_scalars(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Euler XYZ radians, or empty when the arch front is ambiguous.
     * @returns {Float64Array}
     */
    rotation() {
        const ret = wasm.dentalorientresult_rotation(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * @returns {number}
     */
    status() {
        const ret = wasm.dentalorientresult_status(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {Float32Array}
     */
    take_rim_points() {
        const ret = wasm.dentalorientresult_take_rim_points(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    take_visibility_mask() {
        const ret = wasm.dentalorientresult_take_visibility_mask(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) DentalOrientResult.prototype[Symbol.dispose] = DentalOrientResult.prototype.free;

/**
 * A detected region: contours, face cut, contact strip and contacts (Step 2 display and review;
 * the policy itself is `dental_policy`).
 */
export class DentalRegionResult {
    static __wrap(ptr) {
        const obj = Object.create(DentalRegionResult.prototype);
        obj.__wbg_ptr = ptr;
        DentalRegionResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        DentalRegionResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_dentalregionresult_free(ptr, 0);
    }
    /**
     * @returns {Float64Array}
     */
    connector_lengths() {
        const ret = wasm.dentalregionresult_connector_lengths(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Distance along the contour then distance from it, per contact.
     * @returns {Float64Array}
     */
    contact_distances() {
        const ret = wasm.dentalregionresult_contact_distances(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Source face per contact: outer-rim contacts first, then opening-rim contacts.
     * @returns {Uint32Array}
     */
    contact_faces_of() {
        const ret = wasm.dentalregionresult_contact_faces_of(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Position XYZ then normal XYZ per contact.
     * @returns {Float64Array}
     */
    contact_points() {
        const ret = wasm.dentalregionresult_contact_points(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * 0 outer rim, 1 opening rim, per contact.
     * @returns {Uint8Array}
     */
    contact_rims() {
        const ret = wasm.dentalregionresult_contact_rims(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {boolean}
     */
    ok() {
        const ret = wasm.dentalregionresult_ok(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {string}
     */
    reason() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.dentalregionresult_reason(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Faces on the opening-facing side, then on the other side.
     * @returns {Uint32Array}
     */
    region_faces() {
        const ret = wasm.dentalregionresult_region_faces(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    take_allowed_faces() {
        const ret = wasm.dentalregionresult_take_allowed_faces(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * The contact strip (1 byte per face).
     * @returns {Uint8Array}
     */
    take_contact_faces() {
        const ret = wasm.dentalregionresult_take_contact_faces(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint32Array}
     */
    take_opening_edges() {
        const ret = wasm.dentalregionresult_take_opening_edges(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint32Array}
     */
    take_outer_connector_edges() {
        const ret = wasm.dentalregionresult_take_outer_connector_edges(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint32Array}
     */
    take_outer_edges() {
        const ret = wasm.dentalregionresult_take_outer_edges(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint32Array}
     */
    take_outer_ridge_edges() {
        const ret = wasm.dentalregionresult_take_outer_ridge_edges(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
}
if (Symbol.dispose) DentalRegionResult.prototype[Symbol.dispose] = DentalRegionResult.prototype.free;

/**
 * The print-angle search (`dental_tilt_scan`): one row per scanned tilt in step order, the pick
 * order (the pick first), the pick's reason and the stable band. Failed: `ok() == false` with `reason()`.
 */
export class DentalTiltScanResult {
    static __wrap(ptr) {
        const obj = Object.create(DentalTiltScanResult.prototype);
        obj.__wbg_ptr = ptr;
        DentalTiltScanResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        DentalTiltScanResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_dentaltiltscanresult_free(ptr, 0);
    }
    /**
     * First and last row index of the stable band, or empty.
     * @returns {Uint32Array}
     */
    band() {
        const ret = wasm.dentaltiltscanresult_band(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Per row and rule (4 per row): the first failing vertex id (resin trap) or tip id, or "".
     * @returns {string[]}
     */
    failing() {
        const ret = wasm.dentaltiltscanresult_failing(this.__wbg_ptr);
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {boolean}
     */
    ok() {
        const ret = wasm.dentaltiltscanresult_ok(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Row indices in pick order: the pick, then the tilts the confirm tries next.
     * @returns {Uint32Array}
     */
    order() {
        const ret = wasm.dentaltiltscanresult_order(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * 0 robust, 1 passing (no tilt is robust), 2 failing (no tilt passes).
     * @returns {number}
     */
    pick_reason() {
        const ret = wasm.dentaltiltscanresult_pick_reason(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {string}
     */
    reason() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.dentaltiltscanresult_reason(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Per row, 12 numbers: tilt (degrees), steps from the start, rule flags (bit 0 resin trap, 1 rim
     * gap, 2 crossing, 3 too thin), fitting-side tips, largest gap mm, largest slenderness, largest
     * layer mm², height mm, robust (0/1), rotation Euler XYZ radians (3, as the orient result).
     * @returns {Float64Array}
     */
    rows() {
        const ret = wasm.dentaltiltscanresult_rows(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * The start tilt (degrees).
     * @returns {number}
     */
    start_deg() {
        const ret = wasm.dentaltiltscanresult_start_deg(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) DentalTiltScanResult.prototype[Symbol.dispose] = DentalTiltScanResult.prototype.free;

/**
 * The review GLB data of `diagnose`: coloured layers, one per role (docs/SHIP-PLAN.md ABI).
 */
export class Diagnosis {
    static __wrap(ptr) {
        const obj = Object.create(Diagnosis.prototype);
        obj.__wbg_ptr = ptr;
        DiagnosisFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        DiagnosisFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_diagnosis_free(ptr, 0);
    }
    /**
     * 0xRRGGBB.
     * @param {number} layer
     * @returns {number}
     */
    layer_color(layer) {
        const ret = wasm.diagnosis_layer_color(this.__wbg_ptr, layer);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    layer_count() {
        const ret = wasm.diagnosis_layer_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} layer
     * @returns {string}
     */
    layer_name(layer) {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.diagnosis_layer_name(this.__wbg_ptr, layer);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * The request revision, echoed.
     * @returns {number}
     */
    revision() {
        const ret = wasm.diagnosis_revision(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Empty: the positions are a triangle soup.
     * @param {number} layer
     * @returns {Uint32Array}
     */
    take_layer_indices(layer) {
        const ret = wasm.diagnosis_take_layer_indices(this.__wbg_ptr, layer);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @param {number} layer
     * @returns {Float32Array}
     */
    take_layer_positions(layer) {
        const ret = wasm.diagnosis_take_layer_positions(this.__wbg_ptr, layer);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
}
if (Symbol.dispose) Diagnosis.prototype[Symbol.dispose] = Diagnosis.prototype.free;

/**
 * Per-corner positions and flat normals of the approved faces (`allowed[face] == 1`).
 */
export class FaceOverlay {
    static __wrap(ptr) {
        const obj = Object.create(FaceOverlay.prototype);
        obj.__wbg_ptr = ptr;
        FaceOverlayFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        FaceOverlayFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_faceoverlay_free(ptr, 0);
    }
    /**
     * @returns {Float32Array}
     */
    take_normals() {
        const ret = wasm.faceoverlay_take_normals(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    take_positions() {
        const ret = wasm.faceoverlay_take_positions(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
}
if (Symbol.dispose) FaceOverlay.prototype[Symbol.dispose] = FaceOverlay.prototype.free;

/**
 * The result of `generate`: the support mesh arrays and tag tables (layout in `supports::flat`, the
 * tags index into `take_contact_ids`), what was left out, and the verdicts.
 */
export class Generation {
    static __wrap(ptr) {
        const obj = Object.create(Generation.prototype);
        obj.__wbg_ptr = ptr;
        GenerationFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        GenerationFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_generation_free(ptr, 0);
    }
    /**
     * Non-empty when the islands could not be judged (no island is then called resolved).
     * @returns {string}
     */
    island_reason() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.generation_island_reason(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {string}
     */
    reason() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.generation_reason(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * The request revision, echoed so the host can drop a result that is not the newest.
     * @returns {number}
     */
    revision() {
        const ret = wasm.generation_revision(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * 0 clear, 1 blocked, 2 inconclusive.
     * @returns {number}
     */
    status() {
        const ret = wasm.generation_status(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {string[]}
     */
    take_contact_ids() {
        const ret = wasm.generation_take_contact_ids(this.__wbg_ptr);
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {string[]}
     */
    take_dropped() {
        const ret = wasm.generation_take_dropped(this.__wbg_ptr);
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {string[]}
     */
    take_dropped_by_zones() {
        const ret = wasm.generation_take_dropped_by_zones(this.__wbg_ptr);
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Structures the repair switched off: 1 tree, 2 brace, 3 only the crossing brace segments.
     * @returns {Uint8Array}
     */
    take_fallback() {
        const ret = wasm.generation_take_fallback(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint32Array}
     */
    take_indices() {
        const ret = wasm.generation_take_indices(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float64Array}
     */
    take_intents() {
        const ret = wasm.generation_take_intents(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * @returns {Float64Array}
     */
    take_island_heights() {
        const ret = wasm.generation_take_island_heights(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Per island: 0 resolved, 1 unresolved, 2 resolved only through manual support, 3 unresolved but outside the policy's permitted area.
     * @returns {Uint8Array}
     */
    take_island_status() {
        const ret = wasm.generation_take_island_status(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint32Array}
     */
    take_island_vertices() {
        const ret = wasm.generation_take_island_vertices(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * `ISSUE_STRIDE` u32 per crossing of the final mesh.
     * @returns {Uint32Array}
     */
    take_issues() {
        const ret = wasm.generation_take_issues(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    take_positions() {
        const ret = wasm.generation_take_positions(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float64Array}
     */
    take_reach() {
        const ret = wasm.generation_take_reach(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Per ring: perimeter, retained contacts, largest gap, review gap, needs review (0/1).
     * @returns {Float64Array}
     */
    take_rings() {
        const ret = wasm.generation_take_rings(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * @returns {Uint32Array}
     */
    take_tags() {
        const ret = wasm.generation_take_tags(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {number}
     */
    trials() {
        const ret = wasm.generation_trials(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) Generation.prototype[Symbol.dispose] = Generation.prototype.free;

/**
 * Automatic contacts: positions and normals (xyz f64), source codes (0 interior, 1 physical boundary,
 * 2 sharp ridge, 3 island), IDs, and the faces of each downward region.
 */
export class GenericPlacement {
    static __wrap(ptr) {
        const obj = Object.create(GenericPlacement.prototype);
        obj.__wbg_ptr = ptr;
        GenericPlacementFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        GenericPlacementFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_genericplacement_free(ptr, 0);
    }
    /**
     * @returns {string[]}
     */
    take_ids() {
        const ret = wasm.genericplacement_take_ids(this.__wbg_ptr);
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float64Array}
     */
    take_normals() {
        const ret = wasm.genericplacement_take_normals(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * @returns {Float64Array}
     */
    take_positions() {
        const ret = wasm.genericplacement_take_positions(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * @returns {Uint32Array}
     */
    take_region_faces() {
        const ret = wasm.genericplacement_take_region_faces(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Start of each region in `region_faces`, plus the total as the last entry.
     * @returns {Uint32Array}
     */
    take_region_starts() {
        const ret = wasm.genericplacement_take_region_starts(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    take_sources() {
        const ret = wasm.genericplacement_take_sources(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) GenericPlacement.prototype[Symbol.dispose] = GenericPlacement.prototype.free;

/**
 * The composed contacts of a unit as a `PolicyResult`: IDs, positions, normals (xyz f64), origin
 * (1 manual), point class (0 none, 1 face, 2 edge, 3 vertical) and the allowed structures
 * (pillar, tree, brace, roof, cage, raft as 0/1).
 */
export class GenericPolicyResult {
    static __wrap(ptr) {
        const obj = Object.create(GenericPolicyResult.prototype);
        obj.__wbg_ptr = ptr;
        GenericPolicyResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        GenericPolicyResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_genericpolicyresult_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    permitted_faces() {
        const ret = wasm.genericpolicyresult_permitted_faces(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {string[]}
     */
    take_ids() {
        const ret = wasm.genericpolicyresult_take_ids(this.__wbg_ptr);
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    take_kinds() {
        const ret = wasm.genericpolicyresult_take_kinds(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Float64Array}
     */
    take_normals() {
        const ret = wasm.genericpolicyresult_take_normals(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    take_origins() {
        const ret = wasm.genericpolicyresult_take_origins(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Float64Array}
     */
    take_positions() {
        const ret = wasm.genericpolicyresult_take_positions(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    take_structures() {
        const ret = wasm.genericpolicyresult_take_structures(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) GenericPolicyResult.prototype[Symbol.dispose] = GenericPolicyResult.prototype.free;

export class GeometrySession {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        GeometrySessionFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_geometrysession_free(ptr, 0);
    }
    /**
     * The legacy dental placement (a painted-from-scratch area or an older saved policy), see
     * `dental::legacy`: the generic contacts the area permits plus the downward faces filled at
     * `spacing`. Positions and normals are in the turned frame (`rotation`, Euler XYZ radians).
     * @param {number} model
     * @param {string} profile
     * @param {Float64Array} rim
     * @param {Uint8Array} visibility_mask
     * @param {boolean} manual_area
     * @param {Float64Array} stamps
     * @param {Float64Array} rotation
     * @param {number} spacing
     * @param {number} overhang_angle_degrees
     * @param {Float64Array} initial_positions
     * @param {Float64Array} initial_normals
     * @returns {LegacyFill}
     */
    dental_legacy_fill(model, profile, rim, visibility_mask, manual_area, stamps, rotation, spacing, overhang_angle_degrees, initial_positions, initial_normals) {
        const ptr0 = passStringToWasm0(profile, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF64ToWasm0(rim, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArray8ToWasm0(visibility_mask, wasm.__wbindgen_malloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passArrayF64ToWasm0(stamps, wasm.__wbindgen_malloc);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passArrayF64ToWasm0(rotation, wasm.__wbindgen_malloc);
        const len4 = WASM_VECTOR_LEN;
        const ptr5 = passArrayF64ToWasm0(initial_positions, wasm.__wbindgen_malloc);
        const len5 = WASM_VECTOR_LEN;
        const ptr6 = passArrayF64ToWasm0(initial_normals, wasm.__wbindgen_malloc);
        const len6 = WASM_VECTOR_LEN;
        const ret = wasm.geometrysession_dental_legacy_fill(this.__wbg_ptr, model, ptr0, len0, ptr1, len1, ptr2, len2, manual_area, ptr3, len3, ptr4, len4, spacing, overhang_angle_degrees, ptr5, len5, ptr6, len6);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return LegacyFill.__wrap(ret[0]);
    }
    /**
     * The unit's dental policy as a `PolicyResult` for `generate`, made from its saved area and
     * recomputed on use. `kind` 0 older saved policy, 1 area painted from scratch, 2 two-contour
     * (then `tuning` `[setback, width, density]` and the saved region arrays are required; a region
     * that detection does not reproduce permits nothing automatic). `stamps` are the unit-local area
     * edits (`STAMP_STRIDE` each), `structure` `[tree, brace]` as 0/1, `frame` the unit's placement
     * `[position xyz, rotation xyz]` the result is expressed in, `manual_positions` the unit's manual
     * tips (unit-local xyz triples): no suggested tip is offered next to one.
     * @param {number} model
     * @param {string} profile
     * @param {number} kind
     * @param {Float64Array} tuning
     * @param {Float64Array} stamps
     * @param {Uint8Array} saved_allowed_faces
     * @param {Uint8Array} saved_contact_faces
     * @param {Uint32Array} saved_outer_edges
     * @param {Uint32Array} saved_opening_edges
     * @param {Uint8Array} structure
     * @param {Float64Array} frame
     * @param {Float64Array} manual_positions
     * @returns {PolicyHandle}
     */
    dental_policy(model, profile, kind, tuning, stamps, saved_allowed_faces, saved_contact_faces, saved_outer_edges, saved_opening_edges, structure, frame, manual_positions) {
        const ptr0 = passStringToWasm0(profile, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF64ToWasm0(tuning, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArrayF64ToWasm0(stamps, wasm.__wbindgen_malloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passArray8ToWasm0(saved_allowed_faces, wasm.__wbindgen_malloc);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passArray8ToWasm0(saved_contact_faces, wasm.__wbindgen_malloc);
        const len4 = WASM_VECTOR_LEN;
        const ptr5 = passArray32ToWasm0(saved_outer_edges, wasm.__wbindgen_malloc);
        const len5 = WASM_VECTOR_LEN;
        const ptr6 = passArray32ToWasm0(saved_opening_edges, wasm.__wbindgen_malloc);
        const len6 = WASM_VECTOR_LEN;
        const ptr7 = passArray8ToWasm0(structure, wasm.__wbindgen_malloc);
        const len7 = WASM_VECTOR_LEN;
        const ptr8 = passArrayF64ToWasm0(frame, wasm.__wbindgen_malloc);
        const len8 = WASM_VECTOR_LEN;
        const ptr9 = passArrayF64ToWasm0(manual_positions, wasm.__wbindgen_malloc);
        const len9 = WASM_VECTOR_LEN;
        const ret = wasm.geometrysession_dental_policy(this.__wbg_ptr, model, ptr0, len0, kind, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, ptr6, len6, ptr7, len7, ptr8, len8, ptr9, len9);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return PolicyHandle.__wrap(ret[0]);
    }
    /**
     * Print-angle search over the profile's tilt range (docs/ROADMAP.md F) with the host's current
     * support settings. `on_tilt(done, total)`, when given, is called after each scanned tilt.
     * @param {number} model
     * @param {string} profile
     * @param {number} neck_length_mm
     * @param {number} pillar_diameter_mm
     * @param {number} lift_mm
     * @param {boolean} braced
     * @param {Function | null} [on_tilt]
     * @returns {DentalTiltScanResult}
     */
    dental_tilt_scan(model, profile, neck_length_mm, pillar_diameter_mm, lift_mm, braced, on_tilt) {
        const ptr0 = passStringToWasm0(profile, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.geometrysession_dental_tilt_scan(this.__wbg_ptr, model, ptr0, len0, neck_length_mm, pillar_diameter_mm, lift_mm, braced, isLikeNone(on_tilt) ? 0 : addToExternrefTable0(on_tilt));
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return DentalTiltScanResult.__wrap(ret[0]);
    }
    /**
     * Review layers of a loaded aligner: the contact strip, the contours and, when given, the
     * diagnostic strips (`bands`: four masks of one byte per face, or empty), the sampled
     * contacts (position then normal, 6 numbers each), and a support mesh with a tip flag per
     * triangle. Review only; nothing here is support permission.
     * @param {number} model
     * @param {number} revision
     * @param {string} profile
     * @param {Uint8Array} contact_faces
     * @param {Uint32Array} outer_ridge_edges
     * @param {Uint32Array} connector_edges
     * @param {Uint32Array} opening_edges
     * @param {Uint8Array} bands
     * @param {Float64Array} outer_contacts
     * @param {Float64Array} inner_contacts
     * @param {Float32Array} support_positions
     * @param {Uint32Array} support_indices
     * @param {Uint8Array} tip_flags
     * @returns {Diagnosis}
     */
    diagnose(model, revision, profile, contact_faces, outer_ridge_edges, connector_edges, opening_edges, bands, outer_contacts, inner_contacts, support_positions, support_indices, tip_flags) {
        const ptr0 = passStringToWasm0(profile, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(contact_faces, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArray32ToWasm0(outer_ridge_edges, wasm.__wbindgen_malloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passArray32ToWasm0(connector_edges, wasm.__wbindgen_malloc);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passArray32ToWasm0(opening_edges, wasm.__wbindgen_malloc);
        const len4 = WASM_VECTOR_LEN;
        const ptr5 = passArray8ToWasm0(bands, wasm.__wbindgen_malloc);
        const len5 = WASM_VECTOR_LEN;
        const ptr6 = passArrayF64ToWasm0(outer_contacts, wasm.__wbindgen_malloc);
        const len6 = WASM_VECTOR_LEN;
        const ptr7 = passArrayF64ToWasm0(inner_contacts, wasm.__wbindgen_malloc);
        const len7 = WASM_VECTOR_LEN;
        const ptr8 = passArrayF32ToWasm0(support_positions, wasm.__wbindgen_malloc);
        const len8 = WASM_VECTOR_LEN;
        const ptr9 = passArray32ToWasm0(support_indices, wasm.__wbindgen_malloc);
        const len9 = WASM_VECTOR_LEN;
        const ptr10 = passArray8ToWasm0(tip_flags, wasm.__wbindgen_malloc);
        const len10 = WASM_VECTOR_LEN;
        const ret = wasm.geometrysession_diagnose(this.__wbg_ptr, model, revision, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, ptr6, len6, ptr7, len7, ptr8, len8, ptr9, len9, ptr10, len10);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Diagnosis.__wrap(ret[0]);
    }
    /**
     * The support pipeline for a plate-space model: `contacts` and `shapes` as `build_supports`,
     * `policy` the unit's policy as Rust made it (same frame as the model). `timeout_ms` > 0 ends the repair and checks early with
     * an inconclusive verdict (never a clear one) once that much time has passed. `plate_y` is the
     * plate's height in the model's frame: 0 for a model placed on the plate; a lift change keeps the
     * placed model (and its caches) and moves the plate instead. Island heights are above the plate.
     * @param {number} model
     * @param {string[]} ids
     * @param {Float64Array} contacts
     * @param {Float64Array} shapes
     * @param {Float64Array} settings
     * @param {number} mode
     * @param {string} label_text
     * @param {Float64Array} zones
     * @param {PolicyHandle} policy
     * @param {number} timeout_ms
     * @param {number} revision
     * @param {number} plate_y
     * @param {Float64Array} frame
     * @returns {Generation}
     */
    generate(model, ids, contacts, shapes, settings, mode, label_text, zones, policy, timeout_ms, revision, plate_y, frame) {
        const ptr0 = passArrayJsValueToWasm0(ids, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF64ToWasm0(contacts, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArrayF64ToWasm0(shapes, wasm.__wbindgen_malloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passArrayF64ToWasm0(settings, wasm.__wbindgen_malloc);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passStringToWasm0(label_text, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len4 = WASM_VECTOR_LEN;
        const ptr5 = passArrayF64ToWasm0(zones, wasm.__wbindgen_malloc);
        const len5 = WASM_VECTOR_LEN;
        _assertClass(policy, PolicyHandle);
        const ptr6 = passArrayF64ToWasm0(frame, wasm.__wbindgen_malloc);
        const len6 = WASM_VECTOR_LEN;
        const ret = wasm.geometrysession_generate(this.__wbg_ptr, model, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, mode, ptr4, len4, ptr5, len5, policy.__wbg_ptr, timeout_ms, revision, plate_y, ptr6, len6);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Generation.__wrap(ret[0]);
    }
    /**
     * Automatic contacts of a loaded model (already in the frame they are wanted in).
     * @param {number} model
     * @param {Float64Array} settings
     * @returns {GenericPlacement}
     */
    generic_place(model, settings) {
        const ptr0 = passArrayF64ToWasm0(settings, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.geometrysession_generic_place(this.__wbg_ptr, model, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return GenericPlacement.__wrap(ret[0]);
    }
    /**
     * The generic policy of a unit as a `PolicyHandle` for `generate`: its contacts (automatic
     * minus deleted and zoned, plus manual; unit-local), every face of `model` permitted, the
     * structures the settings ask for, and `repair_budget` safety-repair trials (0: report only). Arguments as `generic_policy_contacts`.
     * @param {number} model
     * @param {Float64Array} settings
     * @param {string[]} auto_ids
     * @param {Float64Array} auto_positions
     * @param {Float64Array} auto_normals
     * @param {Uint8Array} auto_sources
     * @param {string[]} manual_ids
     * @param {Float64Array} manual_positions
     * @param {Float64Array} manual_normals
     * @param {Uint8Array} manual_sources
     * @param {string[]} deleted
     * @param {Float64Array} zones
     * @param {number} repair_budget
     * @returns {PolicyHandle}
     */
    generic_policy(model, settings, auto_ids, auto_positions, auto_normals, auto_sources, manual_ids, manual_positions, manual_normals, manual_sources, deleted, zones, repair_budget) {
        const ptr0 = passArrayF64ToWasm0(settings, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayJsValueToWasm0(auto_ids, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArrayF64ToWasm0(auto_positions, wasm.__wbindgen_malloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passArrayF64ToWasm0(auto_normals, wasm.__wbindgen_malloc);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passArray8ToWasm0(auto_sources, wasm.__wbindgen_malloc);
        const len4 = WASM_VECTOR_LEN;
        const ptr5 = passArrayJsValueToWasm0(manual_ids, wasm.__wbindgen_malloc);
        const len5 = WASM_VECTOR_LEN;
        const ptr6 = passArrayF64ToWasm0(manual_positions, wasm.__wbindgen_malloc);
        const len6 = WASM_VECTOR_LEN;
        const ptr7 = passArrayF64ToWasm0(manual_normals, wasm.__wbindgen_malloc);
        const len7 = WASM_VECTOR_LEN;
        const ptr8 = passArray8ToWasm0(manual_sources, wasm.__wbindgen_malloc);
        const len8 = WASM_VECTOR_LEN;
        const ptr9 = passArrayJsValueToWasm0(deleted, wasm.__wbindgen_malloc);
        const len9 = WASM_VECTOR_LEN;
        const ptr10 = passArrayF64ToWasm0(zones, wasm.__wbindgen_malloc);
        const len10 = WASM_VECTOR_LEN;
        const ret = wasm.geometrysession_generic_policy(this.__wbg_ptr, model, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, ptr6, len6, ptr7, len7, ptr8, len8, ptr9, len9, ptr10, len10, repair_budget);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return PolicyHandle.__wrap(ret[0]);
    }
    /**
     * @param {Float32Array} positions
     * @param {Uint32Array} indices
     * @returns {number}
     */
    load_mesh(positions, indices) {
        const ptr0 = passArrayF32ToWasm0(positions, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray32ToWasm0(indices, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.geometrysession_load_mesh(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * `load_mesh` with a pick index built elsewhere (`build_pick_index`, in a worker): used as is,
     * not rebuilt on the first pick. An index that does not fit the mesh is `INVALID_INDEX`.
     * @param {Float32Array} positions
     * @param {Uint32Array} indices
     * @param {Float32Array} bounds
     * @param {Uint32Array} links
     * @param {Uint32Array} order
     * @returns {number}
     */
    load_mesh_indexed(positions, indices, bounds, links, order) {
        const ptr0 = passArrayF32ToWasm0(positions, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray32ToWasm0(indices, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArrayF32ToWasm0(bounds, wasm.__wbindgen_malloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passArray32ToWasm0(links, wasm.__wbindgen_malloc);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passArray32ToWasm0(order, wasm.__wbindgen_malloc);
        const len4 = WASM_VECTOR_LEN;
        const ret = wasm.geometrysession_load_mesh_indexed(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * A copy of a loaded mesh placed by `frame` (`[position xyz, rotation xyz]`), loaded as a new
     * handle in this session: a unit's plate-space model without sending its positions again.
     * @param {number} handle
     * @param {Float64Array} frame
     * @returns {number}
     */
    load_placed(handle, frame) {
        const ptr0 = passArrayF64ToWasm0(frame, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.geometrysession_load_placed(this.__wbg_ptr, handle, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * @param {number} handle
     * @returns {Float32Array}
     */
    mesh_bounds(handle) {
        const ret = wasm.geometrysession_mesh_bounds(this.__wbg_ptr, handle);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @param {number} max_bytes
     */
    constructor(max_bytes) {
        const ret = wasm.geometrysession_new(max_bytes);
        this.__wbg_ptr = ret;
        GeometrySessionFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Step 1: mesh check, orientation, central opening and whether they fit the profile.
     * @param {number} model
     * @param {string} profile
     * @returns {DentalOrientResult}
     */
    orient_dental(model, profile) {
        const ptr0 = passStringToWasm0(profile, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.geometrysession_orient_dental(this.__wbg_ptr, model, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return DentalOrientResult.__wrap(ret[0]);
    }
    /**
     * First hit of each ray (origin xyz, direction xyz, mesh-local): 5 floats per ray
     * (face or -1, distance, x, y, z). `side` 0 front, 1 back, 2 double.
     * @param {number} handle
     * @param {Float64Array} rays
     * @param {number} near
     * @param {number} far
     * @param {number} side
     * @returns {Float64Array}
     */
    pick(handle, rays, near, far, side) {
        const ptr0 = passArrayF64ToWasm0(rays, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.geometrysession_pick(this.__wbg_ptr, handle, ptr0, len0, near, far, side);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v2 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v2;
    }
    /**
     * The mesh's pick index as flat arrays (built now if it has none), to hand to another session.
     * @param {number} handle
     * @returns {PickIndex}
     */
    pick_index(handle) {
        const ret = wasm.geometrysession_pick_index(this.__wbg_ptr, handle);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return PickIndex.__wrap(ret[0]);
    }
    /**
     * `pick` for canvas pixels (x, y pairs, y down); `clip_to_local` inverts projection * view * model.
     * @param {number} handle
     * @param {Float64Array} clip_to_local
     * @param {number} width
     * @param {number} height
     * @param {Float64Array} pixels
     * @param {number} near
     * @param {number} far
     * @param {number} side
     * @returns {Float64Array}
     */
    pick_pixels(handle, clip_to_local, width, height, pixels, near, far, side) {
        const ptr0 = passArrayF64ToWasm0(clip_to_local, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF64ToWasm0(pixels, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.geometrysession_pick_pixels(this.__wbg_ptr, handle, ptr0, len0, width, height, ptr1, len1, near, far, side);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v3 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v3;
    }
    /**
     * Slots of the support bodies the brush stroke touches and can see (ascending). Occluders are
     * session meshes with the support-local to model-local matrices (16 f64 each) and sides.
     * @param {Float32Array} body_points
     * @param {Uint32Array} body_first
     * @param {Uint32Array} occluder_handles
     * @param {Float64Array} occluder_matrices
     * @param {Uint32Array} occluder_sides
     * @param {Float64Array} matrix
     * @param {Float64Array} eye
     * @param {Float64Array} size
     * @param {number} radius
     * @param {Float64Array} stroke
     * @param {number} start
     * @param {number} end
     * @param {Uint8Array} want
     * @returns {Uint32Array}
     */
    project_brush(body_points, body_first, occluder_handles, occluder_matrices, occluder_sides, matrix, eye, size, radius, stroke, start, end, want) {
        const ptr0 = passArrayF32ToWasm0(body_points, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray32ToWasm0(body_first, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArray32ToWasm0(occluder_handles, wasm.__wbindgen_malloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passArrayF64ToWasm0(occluder_matrices, wasm.__wbindgen_malloc);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passArray32ToWasm0(occluder_sides, wasm.__wbindgen_malloc);
        const len4 = WASM_VECTOR_LEN;
        const ptr5 = passArrayF64ToWasm0(matrix, wasm.__wbindgen_malloc);
        const len5 = WASM_VECTOR_LEN;
        const ptr6 = passArrayF64ToWasm0(eye, wasm.__wbindgen_malloc);
        const len6 = WASM_VECTOR_LEN;
        const ptr7 = passArrayF64ToWasm0(size, wasm.__wbindgen_malloc);
        const len7 = WASM_VECTOR_LEN;
        const ptr8 = passArrayF64ToWasm0(stroke, wasm.__wbindgen_malloc);
        const len8 = WASM_VECTOR_LEN;
        const ptr9 = passArray8ToWasm0(want, wasm.__wbindgen_malloc);
        const len9 = WASM_VECTOR_LEN;
        const ret = wasm.geometrysession_project_brush(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, ptr6, len6, ptr7, len7, radius, ptr8, len8, start, end, ptr9, len9);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v11 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v11;
    }
    /**
     * Detects the contours, the face cut and the contact strip, tuned by `[setback, width, density]`.
     * @param {number} model
     * @param {Float64Array} tuning
     * @param {string} profile
     * @returns {DentalRegionResult}
     */
    propose_dental_region(model, tuning, profile) {
        const ptr0 = passArrayF64ToWasm0(tuning, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(profile, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.geometrysession_propose_dental_region(this.__wbg_ptr, model, ptr0, len0, ptr1, len1);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return DentalRegionResult.__wrap(ret[0]);
    }
    /**
     * @param {number} handle
     */
    release_mesh(handle) {
        const ret = wasm.geometrysession_release_mesh(this.__wbg_ptr, handle);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Recomputes the strip and contacts for accepted contours. `phase_fraction` (of the even step)
     * NaN keeps phase 0, the primaries; 0.5 samples halfway between them.
     * @param {number} model
     * @param {Uint8Array} allowed_faces
     * @param {Uint32Array} outer_edges
     * @param {Uint32Array} opening_edges
     * @param {Float64Array} tuning
     * @param {number} phase_fraction
     * @param {string} profile
     * @returns {DentalRegionResult}
     */
    retune_dental_region(model, allowed_faces, outer_edges, opening_edges, tuning, phase_fraction, profile) {
        const ptr0 = passArray8ToWasm0(allowed_faces, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray32ToWasm0(outer_edges, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArray32ToWasm0(opening_edges, wasm.__wbindgen_malloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passArrayF64ToWasm0(tuning, wasm.__wbindgen_malloc);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passStringToWasm0(profile, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len4 = WASM_VECTOR_LEN;
        const ret = wasm.geometrysession_retune_dental_region(this.__wbg_ptr, model, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, phase_fraction, ptr4, len4);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return DentalRegionResult.__wrap(ret[0]);
    }
    /**
     * The mesh's positions through `matrix` (f64[16], column-major); `handedness` 0 keeps the
     * core frame, 1 mirrors Z for a left-handed host.
     * @param {number} handle
     * @param {Float64Array} matrix
     * @param {number} handedness
     * @returns {Float32Array}
     */
    transform(handle, matrix, handedness) {
        const ptr0 = passArrayF64ToWasm0(matrix, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.geometrysession_transform(this.__wbg_ptr, handle, ptr0, len0, handedness);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v2 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v2;
    }
    /**
     * @returns {number}
     */
    used_bytes() {
        const ret = wasm.geometrysession_used_bytes(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) GeometrySession.prototype[Symbol.dispose] = GeometrySession.prototype.free;

/**
 * Result of `rekey_hand_work`: the re-keyed removals, the target of each per-support settings ID
 * (empty string = dropped) and four counts (removals kept / reset, settings kept / reset).
 */
export class HandWork {
    static __wrap(ptr) {
        const obj = Object.create(HandWork.prototype);
        obj.__wbg_ptr = ptr;
        HandWorkFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        HandWorkFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_handwork_free(ptr, 0);
    }
    /**
     * @returns {Uint32Array}
     */
    take_counts() {
        const ret = wasm.handwork_take_counts(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {string[]}
     */
    take_deleted() {
        const ret = wasm.handwork_take_deleted(this.__wbg_ptr);
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {string[]}
     */
    take_targets() {
        const ret = wasm.handwork_take_targets(this.__wbg_ptr);
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
}
if (Symbol.dispose) HandWork.prototype[Symbol.dispose] = HandWork.prototype.free;

/**
 * The legacy dental placement result: the generic contacts kept and the face-fill contacts added.
 */
export class LegacyFill {
    static __wrap(ptr) {
        const obj = Object.create(LegacyFill.prototype);
        obj.__wbg_ptr = ptr;
        LegacyFillFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        LegacyFillFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_legacyfill_free(ptr, 0);
    }
    /**
     * @returns {string[]}
     */
    take_ids() {
        const ret = wasm.legacyfill_take_ids(this.__wbg_ptr);
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Indices (into the generic contacts passed in) that were kept, in order.
     * @returns {Uint32Array}
     */
    take_kept() {
        const ret = wasm.legacyfill_take_kept(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float64Array}
     */
    take_normals() {
        const ret = wasm.legacyfill_take_normals(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Contacts the face fill added.
     * @returns {Float64Array}
     */
    take_positions() {
        const ret = wasm.legacyfill_take_positions(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
}
if (Symbol.dispose) LegacyFill.prototype[Symbol.dispose] = LegacyFill.prototype.free;

/**
 * A mesh's pick index as flat arrays: per node `min xyz, max xyz` (`bounds`) and `start, count`
 * (`links`), then the triangle permutation (`order`). Transferable between realms.
 */
export class PickIndex {
    static __wrap(ptr) {
        const obj = Object.create(PickIndex.prototype);
        obj.__wbg_ptr = ptr;
        PickIndexFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        PickIndexFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_pickindex_free(ptr, 0);
    }
    /**
     * @returns {Float32Array}
     */
    take_bounds() {
        const ret = wasm.pickindex_take_bounds(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint32Array}
     */
    take_links() {
        const ret = wasm.pickindex_take_links(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Uint32Array}
     */
    take_order() {
        const ret = wasm.pickindex_take_order(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
}
if (Symbol.dispose) PickIndex.prototype[Symbol.dispose] = PickIndex.prototype.free;

/**
 * A `PolicyResult` made in Rust (`GeometrySession.dental_policy` / `generic_policy`) and handed
 * straight to `generate`. The host never assembles one; it can only read what it needs to show.
 */
export class PolicyHandle {
    static __wrap(ptr) {
        const obj = Object.create(PolicyHandle.prototype);
        obj.__wbg_ptr = ptr;
        PolicyHandleFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        PolicyHandleFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_policyhandle_free(ptr, 0);
    }
    /**
     * Source face per repair alternate (-1 none), in the order of `alternate_owners`.
     * @returns {Float64Array}
     */
    alternate_faces() {
        const ret = wasm.policyhandle_alternate_faces(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Per repair alternate: the candidate id it stands in for, in trial order.
     * @returns {string[]}
     */
    alternate_owners() {
        const ret = wasm.policyhandle_alternate_owners(this.__wbg_ptr);
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Point xyz then normal xyz per repair alternate, in the order of `alternate_owners`.
     * @returns {Float64Array}
     */
    alternate_points() {
        const ret = wasm.policyhandle_alternate_points(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * 0 every contact as given, 1 only contacts that reproduce a candidate.
     * @returns {number}
     */
    automatic() {
        const ret = wasm.policyhandle_automatic(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Source face per candidate (-1 none).
     * @returns {Float64Array}
     */
    candidate_faces() {
        const ret = wasm.policyhandle_candidate_faces(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Candidate ids, in order.
     * @returns {string[]}
     */
    candidate_ids() {
        const ret = wasm.policyhandle_candidate_ids(this.__wbg_ptr);
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Point xyz then normal xyz per candidate (the frame the policy was made in).
     * @returns {Float64Array}
     */
    candidate_points() {
        const ret = wasm.policyhandle_candidate_points(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * @returns {boolean}
     */
    islands_outside_permitted() {
        const ret = wasm.policyhandle_islands_outside_permitted(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * 1 when secondary landings are limited to the permitted faces.
     * @returns {number}
     */
    landing_rule() {
        const ret = wasm.policyhandle_landing_rule(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * One 0/1 byte per source face.
     * @returns {Uint8Array}
     */
    permitted_faces() {
        const ret = wasm.policyhandle_permitted_faces(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * The aligner profile a dental policy was made with (empty for the generic policy).
     * @returns {string}
     */
    profile_id() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.policyhandle_profile_id(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {number}
     */
    repair_budget() {
        const ret = wasm.policyhandle_repair_budget(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * False when a saved dental area could not be reproduced from the mesh (no automatic support).
     * @returns {boolean}
     */
    reproduced() {
        const ret = wasm.policyhandle_reproduced(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {number}
     */
    ring_count() {
        const ret = wasm.policyhandle_ring_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * pillar, tree, brace, roof, cage, raft (1 = allowed).
     * @returns {Uint8Array}
     */
    structures() {
        const ret = wasm.policyhandle_structures(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Point xyz then normal xyz per suggested tip Add can snap to, painted or not (a dental policy only).
     * @returns {Float64Array}
     */
    suggested_points() {
        const ret = wasm.policyhandle_suggested_points(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
}
if (Symbol.dispose) PolicyHandle.prototype[Symbol.dispose] = PolicyHandle.prototype.free;

/**
 * Overhang spots the contacts leave unsupported: position xyz, area. (Islands are the `generate` verdict.)
 */
export class SupportProblems {
    static __wrap(ptr) {
        const obj = Object.create(SupportProblems.prototype);
        obj.__wbg_ptr = ptr;
        SupportProblemsFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SupportProblemsFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_supportproblems_free(ptr, 0);
    }
    /**
     * @returns {Float64Array}
     */
    take_areas() {
        const ret = wasm.supportproblems_take_areas(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * @returns {Float64Array}
     */
    take_positions() {
        const ret = wasm.supportproblems_take_positions(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
}
if (Symbol.dispose) SupportProblems.prototype[Symbol.dispose] = SupportProblems.prototype.free;

export class WeldResult {
    static __wrap(ptr) {
        const obj = Object.create(WeldResult.prototype);
        obj.__wbg_ptr = ptr;
        WeldResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WeldResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_weldresult_free(ptr, 0);
    }
    /**
     * @returns {Uint32Array}
     */
    take_indices() {
        const ret = wasm.weldresult_take_indices(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {Float32Array}
     */
    take_positions() {
        const ret = wasm.weldresult_take_positions(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
}
if (Symbol.dispose) WeldResult.prototype[Symbol.dispose] = WeldResult.prototype.free;

/**
 * Support bodies as axis segments; component `k` covers `indices[start[k] .. start[k] + count[k]]`
 * and belongs to contact key `contact[k]` (`0xFFFFFFFF` for none).
 * @param {Float32Array} positions
 * @param {Uint32Array} indices
 * @param {Uint32Array} contact
 * @param {Uint32Array} start
 * @param {Uint32Array} count
 * @returns {BodySegmentsResult}
 */
export function body_segments(positions, indices, contact, start, count) {
    const ptr0 = passArrayF32ToWasm0(positions, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray32ToWasm0(indices, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray32ToWasm0(contact, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArray32ToWasm0(start, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ptr4 = passArray32ToWasm0(count, wasm.__wbindgen_malloc);
    const len4 = WASM_VECTOR_LEN;
    const ret = wasm.body_segments(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return BodySegmentsResult.__wrap(ret[0]);
}

/**
 * The pick index of a mesh outside any session (the import worker builds it once; the main
 * thread loads it with `GeometrySession.load_mesh_indexed`).
 * @param {Float32Array} positions
 * @param {Uint32Array} indices
 * @returns {PickIndex}
 */
export function build_pick_index(positions, indices) {
    const ptr0 = passArrayF32ToWasm0(positions, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray32ToWasm0(indices, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.build_pick_index(ptr0, len0, ptr1, len1);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return PickIndex.__wrap(ret[0]);
}

/**
 * Mutates the caller's vertex buffer and returns center XYZ, then original min/max XYZ.
 * @param {Float32Array} positions
 * @returns {Float64Array}
 */
export function center_positions_in_place(positions) {
    var ptr0 = passArrayF32ToWasm0(positions, wasm.__wbindgen_malloc);
    var len0 = WASM_VECTOR_LEN;
    const ret = wasm.center_positions_in_place(ptr0, len0, positions);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v2;
}

/**
 * The support check over a mesh in the frame it is checked in (Y up): `contacts` are xyz triples.
 * @param {Float32Array} positions
 * @param {Uint32Array} indices
 * @param {Float64Array} contacts
 * @param {number} overhang_angle_degrees
 * @param {number} spacing
 * @returns {SupportProblems}
 */
export function check_support_problems(positions, indices, contacts, overhang_angle_degrees, spacing) {
    const ptr0 = passArrayF32ToWasm0(positions, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray32ToWasm0(indices, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayF64ToWasm0(contacts, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.check_support_problems(ptr0, len0, ptr1, len1, ptr2, len2, overhang_angle_degrees, spacing);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return SupportProblems.__wrap(ret[0]);
}

/**
 * Automatic contacts an old radius removal hid.
 * @param {string[]} auto_ids
 * @param {Float64Array} auto_positions
 * @param {string[]} markers
 * @param {number} erase_radius
 * @returns {string[]}
 */
export function contacts_hidden_by_marker_ids(auto_ids, auto_positions, markers, erase_radius) {
    const ptr0 = passArrayJsValueToWasm0(auto_ids, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(auto_positions, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayJsValueToWasm0(markers, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.contacts_hidden_by_marker_ids(ptr0, len0, ptr1, len1, ptr2, len2, erase_radius);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v4 = getArrayJsValueFromWasm0(ret[0], ret[1]);
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v4;
}

/**
 * Returns a simplified display copy; the caller keeps the full mesh for support and export.
 * @param {Float32Array} positions
 * @param {Uint32Array} indices
 * @param {number} max_triangles
 * @returns {WeldResult}
 */
export function decimate_display(positions, indices, max_triangles) {
    const ptr0 = passArrayF32ToWasm0(positions, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray32ToWasm0(indices, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.decimate_display(ptr0, len0, ptr1, len1, max_triangles);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return WeldResult.__wrap(ret[0]);
}

/**
 * One byte per mesh vertex: the legacy allowed-area overlay (the footprint or the paint, and
 * seen first from the opening). `normals` is one unit-frame normal per vertex, or empty.
 * @param {Float32Array} positions
 * @param {Uint32Array} indices
 * @param {Float32Array} normals
 * @param {Float64Array} rim
 * @param {Uint8Array} visibility_mask
 * @param {boolean} manual_area
 * @param {Float64Array} stamps
 * @param {string} profile
 * @returns {Uint8Array}
 */
export function dental_allowed_vertices(positions, indices, normals, rim, visibility_mask, manual_area, stamps, profile) {
    const ptr0 = passArrayF32ToWasm0(positions, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray32ToWasm0(indices, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayF32ToWasm0(normals, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArrayF64ToWasm0(rim, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ptr4 = passArray8ToWasm0(visibility_mask, wasm.__wbindgen_malloc);
    const len4 = WASM_VECTOR_LEN;
    const ptr5 = passArrayF64ToWasm0(stamps, wasm.__wbindgen_malloc);
    const len5 = WASM_VECTOR_LEN;
    const ptr6 = passStringToWasm0(profile, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len6 = WASM_VECTOR_LEN;
    const ret = wasm.dental_allowed_vertices(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, manual_area, ptr5, len5, ptr6, len6);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v8 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v8;
}

/**
 * @returns {number}
 */
export function engine_version() {
    const ret = wasm.engine_version();
    return ret >>> 0;
}

/**
 * @param {Float32Array} positions
 * @param {Uint32Array} pairs
 * @returns {Float32Array}
 */
export function face_mask_contour_segments(positions, pairs) {
    const ptr0 = passArrayF32ToWasm0(positions, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray32ToWasm0(pairs, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.face_mask_contour_segments(ptr0, len0, ptr1, len1);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v3 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v3;
}

/**
 * @param {Float32Array} positions
 * @param {Uint32Array} indices
 * @param {Uint8Array} allowed
 * @returns {FaceOverlay}
 */
export function face_mask_overlay(positions, indices, allowed) {
    const ptr0 = passArrayF32ToWasm0(positions, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray32ToWasm0(indices, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(allowed, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.face_mask_overlay(ptr0, len0, ptr1, len1, ptr2, len2);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return FaceOverlay.__wrap(ret[0]);
}

/**
 * `generic_policy`: the contacts of a unit (unit-local space): automatic minus deleted and zoned,
 * plus manual. `face_count` is the source mesh's face count.
 * @param {number} face_count
 * @param {Float64Array} settings
 * @param {string[]} auto_ids
 * @param {Float64Array} auto_positions
 * @param {Float64Array} auto_normals
 * @param {Uint8Array} auto_sources
 * @param {string[]} manual_ids
 * @param {Float64Array} manual_positions
 * @param {Float64Array} manual_normals
 * @param {Uint8Array} manual_sources
 * @param {string[]} deleted
 * @param {Float64Array} zones
 * @returns {GenericPolicyResult}
 */
export function generic_policy_contacts(face_count, settings, auto_ids, auto_positions, auto_normals, auto_sources, manual_ids, manual_positions, manual_normals, manual_sources, deleted, zones) {
    const ptr0 = passArrayF64ToWasm0(settings, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayJsValueToWasm0(auto_ids, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayF64ToWasm0(auto_positions, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArrayF64ToWasm0(auto_normals, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ptr4 = passArray8ToWasm0(auto_sources, wasm.__wbindgen_malloc);
    const len4 = WASM_VECTOR_LEN;
    const ptr5 = passArrayJsValueToWasm0(manual_ids, wasm.__wbindgen_malloc);
    const len5 = WASM_VECTOR_LEN;
    const ptr6 = passArrayF64ToWasm0(manual_positions, wasm.__wbindgen_malloc);
    const len6 = WASM_VECTOR_LEN;
    const ptr7 = passArrayF64ToWasm0(manual_normals, wasm.__wbindgen_malloc);
    const len7 = WASM_VECTOR_LEN;
    const ptr8 = passArray8ToWasm0(manual_sources, wasm.__wbindgen_malloc);
    const len8 = WASM_VECTOR_LEN;
    const ptr9 = passArrayJsValueToWasm0(deleted, wasm.__wbindgen_malloc);
    const len9 = WASM_VECTOR_LEN;
    const ptr10 = passArrayF64ToWasm0(zones, wasm.__wbindgen_malloc);
    const len10 = WASM_VECTOR_LEN;
    const ret = wasm.generic_policy_contacts(face_count, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, ptr6, len6, ptr7, len7, ptr8, len8, ptr9, len9, ptr10, len10);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return GenericPolicyResult.__wrap(ret[0]);
}

/**
 * Removals that hide an automatic contact right now.
 * @param {string[]} auto_ids
 * @param {string[]} deleted
 * @returns {string[]}
 */
export function hiding_removal_ids(auto_ids, deleted) {
    const ptr0 = passArrayJsValueToWasm0(auto_ids, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayJsValueToWasm0(deleted, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.hiding_removal_ids(ptr0, len0, ptr1, len1);
    var v3 = getArrayJsValueFromWasm0(ret[0], ret[1]);
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v3;
}

/**
 * @param {Float64Array} matrix
 * @returns {Float64Array}
 */
export function invert_matrix(matrix) {
    const ptr0 = passArrayF64ToWasm0(matrix, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.invert_matrix(ptr0, len0);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v2;
}

/**
 * @returns {number}
 */
export function live_mesh_handles() {
    const ret = wasm.live_mesh_handles();
    return ret >>> 0;
}

/**
 * Placement matrix (f64[16]) of a position (mm) and Euler XYZ rotation (radians).
 * @param {Float64Array} position
 * @param {Float64Array} rotation
 * @returns {Float64Array}
 */
export function placement_matrix(position, rotation) {
    const ptr0 = passArrayF64ToWasm0(position, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(rotation, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.placement_matrix(ptr0, len0, ptr1, len1);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v3 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v3;
}

/**
 * The ID each position encodes on the 0.01 mm grid (`auto-X_Y_Z`).
 * @param {Float64Array} positions
 * @returns {string[]}
 */
export function position_ids(positions) {
    const ptr0 = passArrayF64ToWasm0(positions, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.position_ids(ptr0, len0);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayJsValueFromWasm0(ret[0], ret[1]);
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v2;
}

/**
 * A finer display copy of a mesh for the zone layer (the input when it already fits).
 * @param {Float32Array} positions
 * @param {Uint32Array} indices
 * @param {number} max_edge
 * @param {number} max_triangles
 * @returns {WeldResult}
 */
export function refine_for_overlay(positions, indices, max_edge, max_triangles) {
    const ptr0 = passArrayF32ToWasm0(positions, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray32ToWasm0(indices, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.refine_for_overlay(ptr0, len0, ptr1, len1, max_edge, max_triangles);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return WeldResult.__wrap(ret[0]);
}

/**
 * IDs of stored automatic contacts re-derived from their positions (`rekeyPoints`).
 * @param {string[]} ids
 * @param {Float64Array} positions
 * @returns {string[]}
 */
export function rekey_contact_ids(ids, positions) {
    const ptr0 = passArrayJsValueToWasm0(ids, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(positions, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.rekey_contact_ids(ptr0, len0, ptr1, len1);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v3 = getArrayJsValueFromWasm0(ret[0], ret[1]);
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v3;
}

/**
 * @param {string[]} deleted
 * @param {string[]} override_ids
 * @param {string[]} manual_ids
 * @param {string[]} point_ids
 * @param {Float64Array} point_positions
 * @param {number} match_radius
 * @returns {HandWork}
 */
export function rekey_hand_work(deleted, override_ids, manual_ids, point_ids, point_positions, match_radius) {
    const ptr0 = passArrayJsValueToWasm0(deleted, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayJsValueToWasm0(override_ids, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayJsValueToWasm0(manual_ids, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArrayJsValueToWasm0(point_ids, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ptr4 = passArrayF64ToWasm0(point_positions, wasm.__wbindgen_malloc);
    const len4 = WASM_VECTOR_LEN;
    const ret = wasm.rekey_hand_work(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, match_radius);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return HandWork.__wrap(ret[0]);
}

/**
 * The deleted IDs, re-keyed to a fresh placement (`remap_deleted`).
 * @param {string[]} deleted
 * @param {string[]} point_ids
 * @param {Float64Array} point_positions
 * @param {number} match_radius
 * @returns {string[]}
 */
export function remap_deleted_ids(deleted, point_ids, point_positions, match_radius) {
    const ptr0 = passArrayJsValueToWasm0(deleted, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayJsValueToWasm0(point_ids, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayF64ToWasm0(point_positions, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.remap_deleted_ids(ptr0, len0, ptr1, len1, ptr2, len2, match_radius);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v4 = getArrayJsValueFromWasm0(ret[0], ret[1]);
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v4;
}

/**
 * Positions of any mesh (not necessarily in a session) through a matrix; see `GeometrySession.transform`.
 * @param {Float32Array} positions
 * @param {Float64Array} matrix
 * @param {number} handedness
 * @returns {Float32Array}
 */
export function transform_positions(positions, matrix, handedness) {
    const ptr0 = passArrayF32ToWasm0(positions, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(matrix, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.transform_positions(ptr0, len0, ptr1, len1, handedness);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v3 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v3;
}

/**
 * A batch of f64 xyz triples through a matrix as points (with divide) or normalised directions.
 * @param {Float64Array} values
 * @param {Float64Array} matrix
 * @param {boolean} direction
 * @returns {Float64Array}
 */
export function transform_vectors(values, matrix, direction) {
    const ptr0 = passArrayF64ToWasm0(values, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(matrix, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.transform_vectors(ptr0, len0, ptr1, len1, direction);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v3 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v3;
}

/**
 * Lowest y of the positions through a matrix (float32 like `transform_positions`), without the copy.
 * @param {Float32Array} positions
 * @param {Float64Array} matrix
 * @returns {number}
 */
export function transformed_min_y(positions, matrix) {
    const ptr0 = passArrayF32ToWasm0(positions, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(matrix, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.transformed_min_y(ptr0, len0, ptr1, len1);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0];
}

/**
 * @param {Float32Array} positions
 * @param {Uint32Array} indices
 * @returns {Float32Array}
 */
export function vertex_normals(positions, indices) {
    const ptr0 = passArrayF32ToWasm0(positions, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray32ToWasm0(indices, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.vertex_normals(ptr0, len0, ptr1, len1);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v3 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v3;
}

/**
 * Transforms and welds one raw mesh; empty indices mean sequential corners.
 * @param {Float32Array} positions
 * @param {Uint32Array} indices
 * @param {Float64Array} matrix
 * @returns {WeldResult}
 */
export function weld_positions_in_place(positions, indices, matrix) {
    var ptr0 = passArrayF32ToWasm0(positions, wasm.__wbindgen_malloc);
    var len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray32ToWasm0(indices, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayF64ToWasm0(matrix, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.weld_positions_in_place(ptr0, len0, positions, ptr1, len1, ptr2, len2);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return WeldResult.__wrap(ret[0]);
}

/**
 * Whether `point` is zoned by the no-support `zones` (`ZONE_STRIDE` f64 each): the last stamp that
 * reaches it decides, and an empty `normal` skips the side test. The one place the host asks the
 * stamp rule (`AreaStamp::resolve`), e.g. whether a check finding lies in a zone.
 * @param {Float64Array} zones
 * @param {Float64Array} point
 * @param {Float64Array} normal
 * @returns {boolean}
 */
export function zoned_at(zones, point, normal) {
    const ptr0 = passArrayF64ToWasm0(zones, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(point, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayF64ToWasm0(normal, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.zoned_at(ptr0, len0, ptr1, len1, ptr2, len2);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] !== 0;
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_copy_to_typed_array_88899a52af046901: function(arg0, arg1, arg2) {
            new Uint8Array(arg2.buffer, arg2.byteOffset, arg2.byteLength).set(getArrayU8FromWasm0(arg0, arg1));
        },
        __wbg___wbindgen_string_get_0380ccaa2f57f0d9: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'string' ? obj : undefined;
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_throw_41e9ee4f547fc59a: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_call_1875a20c43a36133: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            const ret = arg0.call(arg1, arg2, arg3);
            return ret;
        }, arguments); },
        __wbg_new_343a093a3c2ffb4e: function(arg0, arg1) {
            const ret = new Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_now_aa4ccb83129e9e55: function() {
            const ret = Date.now();
            return ret;
        },
        __wbg_set_145a351398b48c65: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = Reflect.set(arg0, arg1, arg2);
            return ret;
        }, arguments); },
        __wbindgen_generic_0000000000000001: function(arg0) {
            // Cast intrinsic for `F64 -> Externref`.
            const ret = arg0;
            return ret;
        },
        __wbindgen_generic_0000000000000002: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./mixo_geometry_wasm_bg.js": import0,
    };
}

const AsciiStlSessionFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_asciistlsession_free(ptr, 1));
const BinaryStlSessionFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_binarystlsession_free(ptr, 1));
const BodySegmentsResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_bodysegmentsresult_free(ptr, 1));
const DentalOrientResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_dentalorientresult_free(ptr, 1));
const DentalRegionResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_dentalregionresult_free(ptr, 1));
const DentalTiltScanResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_dentaltiltscanresult_free(ptr, 1));
const DiagnosisFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_diagnosis_free(ptr, 1));
const FaceOverlayFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_faceoverlay_free(ptr, 1));
const GenerationFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_generation_free(ptr, 1));
const GenericPlacementFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_genericplacement_free(ptr, 1));
const GenericPolicyResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_genericpolicyresult_free(ptr, 1));
const GeometrySessionFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_geometrysession_free(ptr, 1));
const HandWorkFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_handwork_free(ptr, 1));
const LegacyFillFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_legacyfill_free(ptr, 1));
const PickIndexFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_pickindex_free(ptr, 1));
const PolicyHandleFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_policyhandle_free(ptr, 1));
const SupportProblemsFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_supportproblems_free(ptr, 1));
const WeldResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_weldresult_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function _assertClass(instance, klass) {
    if (!(instance instanceof klass)) {
        throw new Error(`expected instance of ${klass.name}`);
    }
}

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayF64FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}

function getArrayJsValueFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    const mem = getDataViewMemory0();
    const result = [];
    for (let i = ptr; i < ptr + 4 * len; i += 4) {
        result.push(wasm.__wbindgen_externrefs.get(mem.getUint32(i, true)));
    }
    wasm.__externref_drop_slice(ptr, len);
    return result;
}

function getArrayU32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
        cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getUint32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getFloat32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF64ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 8, 8) >>> 0;
    getFloat64ArrayMemory0().set(arg, ptr / 8);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayJsValueToWasm0(array, malloc) {
    const ptr = malloc(array.length * 4, 4) >>> 0;
    for (let i = 0; i < array.length; i++) {
        const add = addToExternrefTable0(array[i]);
        getDataViewMemory0().setUint32(ptr + 4 * i, add, true);
    }
    WASM_VECTOR_LEN = array.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedFloat32ArrayMemory0 = null;
    cachedFloat64ArrayMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (!module.ok) {
            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
        }

        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('mixo_geometry_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };

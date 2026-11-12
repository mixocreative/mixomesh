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
     * What the trim found (engine 13, `dental::trim`): 0 open arch (the trim plane and its U ends
     * decided up and front), 1 ring (a U bridged by a plate; the floor rule decided), 2 not oriented.
     * @returns {number}
     */
    arch_kind() {
        const ret = wasm.dentalorientresult_arch_kind(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Whether the rule that did not decide agrees on up/down: 0 agrees, 1 inconclusive, 2 disagrees
     * (the host reports a disagreement as needing a look; nothing resolves it silently).
     * @returns {number}
     */
    cross_check() {
        const ret = wasm.dentalorientresult_cross_check(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * confidence, floor offset ratio (how far the axis-facing floor leans toward one end), axial variance ratio.
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
     * bitangent (3 each), visibility resolution, visibility min (2), visibility max (2), whether the
     * trim's U decided a front (0/1), that front (3; zeros without one).
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
 * The rim built from a loop the operator drew on the surface. Deliberately NOT a
 * `DentalOrientResult`: that result also carries `diagnostics`, `opening`, `arch` and
 * `cross_check`, which are measurements of a detection that did not happen here, and a drawn rim
 * has no honest value for any of them. The three rim getters keep the orient result's names and
 * shapes, so the host reads either with one decoder.
 */
export class DentalRimResult {
    static __wrap(ptr) {
        const obj = Object.create(DentalRimResult.prototype);
        obj.__wbg_ptr = ptr;
        DentalRimResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        DentalRimResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_dentalrimresult_free(ptr, 0);
    }
    /**
     * Whether `flip` reversed the side the floor rule chose.
     * @returns {boolean}
     */
    flipped() {
        const ret = wasm.dentalrimresult_flipped(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * The side evidence: `orient::floor_offset` along the fitted plane normal before any flip, in
     * [-1, 1]. Positive means the axis-facing floor area leans the way that normal points, so the
     * opening was taken to face the other way. Near zero the floor decides nothing - that is what
     * `rim-side-uncertain` reports.
     * @returns {number}
     */
    floor_offset() {
        const ret = wasm.dentalrimresult_floor_offset(this.__wbg_ptr);
        return ret;
    }
    /**
     * False when the drawn points fit no plane (a normal result, not a throw); `reason` says why.
     * @returns {boolean}
     */
    ok() {
        const ret = wasm.dentalrimresult_ok(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * `rim-collinear` when the points lie on a line; `rim-side-uncertain` on an otherwise good rim
     * whose floor lean did not reach the profile's minimum, so the side needs the operator's eye
     * (see `floor_offset`). Empty when the side is certain.
     * @returns {string}
     */
    reason() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.dentalrimresult_reason(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * As `DentalOrientResult::rim_scalars` (22 values, same layout); empty when not `ok`.
     * @returns {Float64Array}
     */
    rim_scalars() {
        const ret = wasm.dentalrimresult_rim_scalars(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * The drawn loop points as f32 xyz triples, as given.
     * @returns {Float32Array}
     */
    take_rim_points() {
        const ret = wasm.dentalrimresult_take_rim_points(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * The visibility footprint, `resolution * resolution` bytes, built by the engine's own
     * rasteriser exactly as an orientation-derived rim's is.
     * @returns {Uint8Array}
     */
    take_visibility_mask() {
        const ret = wasm.dentalrimresult_take_visibility_mask(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) DentalRimResult.prototype[Symbol.dispose] = DentalRimResult.prototype.free;

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
     * Denture scan: per row, how many lowest points no support can reach at that tilt; empty for the aligner scan or with the rule off.
     * @returns {Uint32Array}
     */
    boxed_counts() {
        const ret = wasm.dentaltiltscanresult_boxed_counts(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Denture scan: the picked row's boxed-in lowest points, x y z each (mesh frame, mm).
     * @returns {Float64Array}
     */
    boxed_points() {
        const ret = wasm.dentaltiltscanresult_boxed_points(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Denture scan: why each of `boxed_points()` is boxed in, same order.
     * @returns {string[]}
     */
    boxed_reasons() {
        const ret = wasm.dentaltiltscanresult_boxed_reasons(this.__wbg_ptr);
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Denture scan (engine 35): per row, how many lowest points the tilt pick counted; empty with no lowest-point score on.
     * @returns {Uint32Array}
     */
    counted_lows() {
        const ret = wasm.dentaltiltscanresult_counted_lows(this.__wbg_ptr);
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
     * Denture scan with rule `landingTiltWeight` above 0 (engine 32): per row 4 numbers, lowest points without a path, tips without a path,
     * tips with only a fallback path, tips; empty otherwise.
     * @returns {Uint32Array}
     */
    path_counts() {
        const ret = wasm.dentaltiltscanresult_path_counts(this.__wbg_ptr);
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
    /**
     * Denture scan with rule `tiltPickOrder` 1 (engine 35): per row 2 numbers, tips needed, tips in unwanted areas; empty otherwise.
     * @returns {Uint32Array}
     */
    tip_counts() {
        const ret = wasm.dentaltiltscanresult_tip_counts(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
}
if (Symbol.dispose) DentalTiltScanResult.prototype[Symbol.dispose] = DentalTiltScanResult.prototype.free;

/**
 * Support-area comparison: per-face classes and the three areas (mm^2).
 */
export class DentureAreaResult {
    static __wrap(ptr) {
        const obj = Object.create(DentureAreaResult.prototype);
        obj.__wbg_ptr = ptr;
        DentureAreaResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        DentureAreaResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_denturearearesult_free(ptr, 0);
    }
    /**
     * Owner area, generated area, area in both (mm^2).
     * @returns {Float64Array}
     */
    areas() {
        const ret = wasm.denturearearesult_areas(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Per face: 0 neither, 1 owner only, 2 generated only, 3 both.
     * @returns {Uint8Array}
     */
    mask() {
        const ret = wasm.denturearearesult_mask(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) DentureAreaResult.prototype[Symbol.dispose] = DentureAreaResult.prototype.free;

/**
 * One mesh's live tilt view. Failed to prepare (the mesh cannot be oriented): `ok() == false` with `reason()`.
 */
export class DentureLiveTilt {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        DentureLiveTiltFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_denturelivetilt_free(ptr, 0);
    }
    /**
     * Does the per-model work for `positions` / `indices` (moved in) under the denture profile `profile`, with the scan settings and
     * the rule overrides (`rules` in `rule_names()` order, NaN keeps the default) `denture_tilt_paths` takes.
     * @param {Float32Array} positions
     * @param {Uint32Array} indices
     * @param {string} profile
     * @param {number} neck_length_mm
     * @param {number} pillar_diameter_mm
     * @param {number} lift_mm
     * @param {boolean} braced
     * @param {Float64Array} rules
     */
    constructor(positions, indices, profile, neck_length_mm, pillar_diameter_mm, lift_mm, braced, rules) {
        const ptr0 = passArrayF32ToWasm0(positions, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray32ToWasm0(indices, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(profile, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passArrayF64ToWasm0(rules, wasm.__wbindgen_malloc);
        const len3 = WASM_VECTOR_LEN;
        const ret = wasm.denturelivetilt_new(ptr0, len0, ptr1, len1, ptr2, len2, neck_length_mm, pillar_diameter_mm, lift_mm, braced, ptr3, len3);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        DentureLiveTiltFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * False when the per-model work failed (see `reason`); `paths` then answers failed for every tilt.
     * @returns {boolean}
     */
    ok() {
        const ret = wasm.denturelivetilt_ok(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * The tips and path states at `tilt_deg` (degrees from upright), as `denture_tilt_paths` gives them.
     * @param {number} tilt_deg
     * @returns {DentureTiltPaths}
     */
    paths(tilt_deg) {
        const ret = wasm.denturelivetilt_paths(this.__wbg_ptr, tilt_deg);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return DentureTiltPaths.__wrap(ret[0]);
    }
    /**
     * Why the per-model work failed (`orientation-...`); empty when ok.
     * @returns {string}
     */
    reason() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.denturelivetilt_reason(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
}
if (Symbol.dispose) DentureLiveTilt.prototype[Symbol.dispose] = DentureLiveTilt.prototype.free;

/**
 * Step 1 result for a denture. Failed: `status() == 1` with `reason()`. Oriented: `status() == 0`.
 */
export class DentureOrientResult {
    static __wrap(ptr) {
        const obj = Object.create(DentureOrientResult.prototype);
        obj.__wbg_ptr = ptr;
        DentureOrientResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        DentureOrientResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_dentureorientresult_free(ptr, 0);
    }
    /**
     * flatness (smallest / largest covariance eigenvalue), legs gap ratio, teeth offset mm.
     * @returns {Float64Array}
     */
    diagnostics() {
        const ret = wasm.dentureorientresult_diagnostics(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * The arch frame: centroid, up (apex direction), teeth side, across (3 each); empty when failed.
     * @returns {Float64Array}
     */
    frame() {
        const ret = wasm.dentureorientresult_frame(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Failure reason (`too-few-vertices`, `no-arch-plane`, `no-legs`, `both-ends-split`), empty when oriented.
     * @returns {string}
     */
    reason() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.dentureorientresult_reason(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Euler XYZ radians turning the mesh upright (tilt 0); empty when failed.
     * @returns {Float64Array}
     */
    rotation() {
        const ret = wasm.dentureorientresult_rotation(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * @returns {number}
     */
    status() {
        const ret = wasm.dentureorientresult_status(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * False when the teeth side's lean was below the profile's minimum (a side was still taken;
     * the host reports it as needing a look).
     * @returns {boolean}
     */
    teeth_decided() {
        const ret = wasm.dentureorientresult_teeth_decided(this.__wbg_ptr);
        return ret !== 0;
    }
}
if (Symbol.dispose) DentureOrientResult.prototype[Symbol.dispose] = DentureOrientResult.prototype.free;

/**
 * The review layers of the owner denture rules, flat numbers in the mesh frame (mm).
 */
export class DentureReviewResult {
    static __wrap(ptr) {
        const obj = Object.create(DentureReviewResult.prototype);
        obj.__wbg_ptr = ptr;
        DentureReviewResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        DentureReviewResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_denturereviewresult_free(ptr, 0);
    }
    /**
     * Step 2, per face: 1 when a ray from the back origin reaches it first (ALLOWED; overrides no-support; tips stand only here), else 0.
     * @returns {Uint8Array}
     */
    allowed_mask() {
        const ret = wasm.denturereviewresult_allowed_mask(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Per open-area region `[projected mm2, steepness, height mm, pitch mm, faces, tips]`, six values each (engine 45, rule `areaDensity`); empty with the rule off.
     * @returns {Float64Array}
     */
    area_regions() {
        const ret = wasm.denturereviewresult_area_regions(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Tight box: centre (3, the line-of-sight point), axes (9), half extents (3).
     * @returns {Float64Array}
     */
    box_() {
        const ret = wasm.denturereviewresult_box_(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Length (mm) of each chain.
     * @returns {Float64Array}
     */
    chain_lengths() {
        const ret = wasm.denturereviewresult_chain_lengths(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * The continuous down-edge chains: `x y z` per point, chains back to back (sizes in `chain_sizes`).
     * @returns {Float64Array}
     */
    chain_points() {
        const ret = wasm.denturereviewresult_chain_points(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Point count of each chain.
     * @returns {Uint32Array}
     */
    chain_sizes() {
        const ret = wasm.denturereviewresult_chain_sizes(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * The hard edges that face down in the oriented pose (before the print tilt), same layout.
     * @returns {Float64Array}
     */
    down_edges() {
        const ret = wasm.denturereviewresult_down_edges(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Overhang candidates, per face: 1 when within 60 degrees of straight down for the reviewed plate normal.
     * @returns {Uint8Array}
     */
    down_mask() {
        const ret = wasm.denturereviewresult_down_mask(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Per face: the pocket level (1..4), 5 on a hard-to-clean socket, 0 elsewhere: the layer "Drain / clean". Empty with `trapCheck` off.
     * @returns {Uint8Array}
     */
    drain_mask() {
        const ret = wasm.denturereviewresult_drain_mask(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Pockets that hold resin after printing (engine 44): 10 numbers each: volume mm3, depth mm, opening width mm, aspect (depth / width), area mm2, vented 0/1, level (1 drains, 2 low, 3 medium, 4 high), floor x y z.
     * @returns {Float64Array}
     */
    drain_pockets() {
        const ret = wasm.denturereviewresult_drain_pockets(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Tooth sockets at least `drainSocketDepthMm` deep (hard to clean): 6 numbers each: depth mm, area mm2, width mm, floor x y z.
     * @returns {Float64Array}
     */
    drain_sockets() {
        const ret = wasm.denturereviewresult_drain_sockets(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * The part id of every face of the file (engine 50; the layer "Parts"); every review runs on the target part.
     * @returns {Uint32Array}
     */
    face_parts() {
        const ret = wasm.denturereviewresult_face_parts(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * The fitting basin against the zones, face counts: fitting, fitting and allowed, fitting and no-support, fitting and neither, allowed but not fitting.
     * @returns {Uint32Array}
     */
    fitting_check() {
        const ret = wasm.denturereviewresult_fitting_check(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Per face: 1 on the fitting surface seen as a basin from the tissue side (a cross-check layer; it changes no tip).
     * @returns {Uint8Array}
     */
    fitting_mask() {
        const ret = wasm.denturereviewresult_fitting_mask(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Every hard edge as segments `ax ay az bx by bz`.
     * @returns {Float64Array}
     */
    hard_edges() {
        const ret = wasm.denturereviewresult_hard_edges(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Per face: 1 within 5 mm along the surface of a hole (support-allowed).
     * @returns {Uint8Array}
     */
    hole_band_mask() {
        const ret = wasm.denturereviewresult_hole_band_mask(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Per hole: area (mm2), faces next to it.
     * @returns {Float64Array}
     */
    hole_info() {
        const ret = wasm.denturereviewresult_hole_info(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * The hole outlines (hit points around each hole seen along the teeth axis), `x y z` points back to back.
     * @returns {Float64Array}
     */
    hole_outlines() {
        const ret = wasm.denturereviewresult_hole_outlines(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Point count of each hole outline.
     * @returns {Uint32Array}
     */
    hole_sizes() {
        const ret = wasm.denturereviewresult_hole_sizes(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * The islands of the reviewed pose, 9 numbers each (layout as `PolicyHandle::island_facts`; the serving tip index counts into `tips`). Empty with the rule `islandTips` off.
     * @returns {Float64Array}
     */
    islands() {
        const ret = wasm.denturereviewresult_islands(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Why the islands could not be told; empty when they could.
     * @returns {string}
     */
    islands_note() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.denturereviewresult_islands_note(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Low points that got a tip (xyz each).
     * @returns {Float64Array}
     */
    low_tip_points() {
        const ret = wasm.denturereviewresult_low_tip_points(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Per low tip: 0 allowed, 1 outside the no-support zone, 2 within lowRimBandMm of the rim, 3 anywhere (lowOutsideAllowed 2).
     * @returns {Uint8Array}
     */
    low_tip_reasons() {
        const ret = wasm.denturereviewresult_low_tip_reasons(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * The island and lowest-point tips standing on a socket (kept), xyz each.
     * @returns {Float64Array}
     */
    lows_in_sockets() {
        const ret = wasm.denturereviewresult_lows_in_sockets(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Island and lowest-point tips on a face that is not down-facing, xyz triples (engine 39).
     * @returns {Float64Array}
     */
    lows_not_down_facing() {
        const ret = wasm.denturereviewresult_lows_not_down_facing(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Low points outside the allowed area (left unsupported), `x y z` each.
     * @returns {Float64Array}
     */
    lows_outside() {
        const ret = wasm.denturereviewresult_lows_outside(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * The face of each `lows_outside` point.
     * @returns {Uint32Array}
     */
    lows_outside_faces() {
        const ret = wasm.denturereviewresult_lows_outside_faces(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Allowed low points no tip reaches, `x y z` each.
     * @returns {Float64Array}
     */
    lows_unreached() {
        const ret = wasm.denturereviewresult_lows_unreached(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * The face of each `lows_unreached` point.
     * @returns {Uint32Array}
     */
    lows_unreached_faces() {
        const ret = wasm.denturereviewresult_lows_unreached_faces(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * The unit 45 degree no-support ray direction xyz.
     * @returns {Float64Array}
     */
    no_support_dir() {
        const ret = wasm.denturereviewresult_no_support_dir(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Step 1, per face: 1 when a 45 degree front-top parallel ray hits it first (NO_SUPPORT before the override), else 0.
     * @returns {Uint8Array}
     */
    no_support_mask() {
        const ret = wasm.denturereviewresult_no_support_mask(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * The R1b angle in degrees, 0 when off (engine 36).
     * @returns {number}
     */
    no_support_steep_deg() {
        const ret = wasm.denturereviewresult_no_support_steep_deg(this.__wbg_ptr);
        return ret;
    }
    /**
     * Per face: 1 when only R1b (the steep no-support ray, rule `noSupportSteepDeg`) hits it first, not R1; a subset of `no_support_mask`; all 0 with R1b off (engine 36).
     * @returns {Uint8Array}
     */
    no_support_steep_mask() {
        const ret = wasm.denturereviewresult_no_support_steep_mask(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Oral cavity ray origin xyz: on the rim plane, at the back edge of the tight box, on the symmetry plane (the allowed-area rays start here).
     * @returns {Float64Array}
     */
    oral_cavity_ray() {
        const ret = wasm.denturereviewresult_oral_cavity_ray(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * The file's parts, 6 numbers each: id, role (0 target, 1 add-on, 2 debris), triangles, volume mm3, area mm2, review tips on it.
     * @returns {Float64Array}
     */
    part_list() {
        const ret = wasm.denturereviewresult_part_list(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Pillar geometry inputs: contact ball diameter, frustum base diameter, neck length, pillar diameter, lift (mm).
     * @returns {Float64Array}
     */
    pillar() {
        const ret = wasm.denturereviewresult_pillar(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Candidates released because their face is not an overhang for the plate normal.
     * @returns {number}
     */
    released() {
        const ret = wasm.denturereviewresult_released(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Per face: 1 within the dental rim band of the dental rim (support-allowed; overhanging band faces get dental rim tips).
     * @returns {Uint8Array}
     */
    rim_band_mask() {
        const ret = wasm.denturereviewresult_rim_band_mask(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Per rim polyline: 1 when closed (the last edge joins the last point to the first).
     * @returns {Uint8Array}
     */
    rim_closed() {
        const ret = wasm.denturereviewresult_rim_closed(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Mesh edge ids of the rim polylines, back to back (a closed line has as many edges as points, an open one one fewer).
     * @returns {Uint32Array}
     */
    rim_edges() {
        const ret = wasm.denturereviewresult_rim_edges(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Total rim length (mm), line count, all the way around 0/1, largest empty stretch (deg); zeros without a rim.
     * @returns {Float64Array}
     */
    rim_info() {
        const ret = wasm.denturereviewresult_rim_info(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * The rim (engine 20): one or more ordered polylines of mesh vertex positions, `x y z` each, back to back.
     * @returns {Float64Array}
     */
    rim_loops() {
        const ret = wasm.denturereviewresult_rim_loops(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Local lows of the dental rim whose face points up: no tip (rule `rimLowNeedsOverhang`); not "left out".
     * @returns {number}
     */
    rim_lows_facing_up() {
        const ret = wasm.denturereviewresult_rim_lows_facing_up(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Rim plane: point xyz, unit normal xyz pointing to the top; empty without a rim.
     * @returns {Float64Array}
     */
    rim_plane() {
        const ret = wasm.denturereviewresult_rim_plane(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Point count of each rim polyline.
     * @returns {Uint32Array}
     */
    rim_sizes() {
        const ret = wasm.denturereviewresult_rim_sizes(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Faces of the self-supporting overhang regions (rule `overhangSelfSupport`, engine 38): they get no open-area tips; empty with the rule off.
     * @returns {Uint32Array}
     */
    self_support_faces() {
        const ret = wasm.denturereviewresult_self_support_faces(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * `[overhang regions, self-supporting regions, open-area tips saved]` (engine 38); zeros with the rule off.
     * @returns {Float64Array}
     */
    self_support_info() {
        const ret = wasm.denturereviewresult_self_support_info(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Per face: 1 on a tooth socket (`dental/denture/sockets.rs`, rule `socketMinDepthMm`), shown whether or not `socketNoSupport` is on.
     * @returns {Uint8Array}
     */
    socket_mask() {
        const ret = wasm.denturereviewresult_socket_mask(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Basin faces the allowed area covers (R2 and the hole band), so not sockets (the allowed area cancels the socket mask, engine 59).
     * @returns {number}
     */
    sockets_cancelled_by_r2() {
        const ret = wasm.denturereviewresult_sockets_cancelled_by_r2(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Suction cups at the reviewed tilt (engine 44, rule `trapCheck`): 10 numbers each: area mm2 (projected on the plate), volume mm3, depth mm, rim min and max height mm (above the model's lowest point along the print up), vented 0/1, level (1 vented, 2 low, 3 medium, 4 high), floor x y z. Empty with `trapCheck` off.
     * @returns {Float64Array}
     */
    suction_cups() {
        const ret = wasm.denturereviewresult_suction_cups(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Per face: the level of the suction cup it belongs to (0 none): the layer "Suction cups". Empty with `trapCheck` off.
     * @returns {Uint8Array}
     */
    suction_mask() {
        const ret = wasm.denturereviewresult_suction_mask(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Symmetry plane (splits the U left/right): point xyz, unit normal xyz.
     * @returns {Float64Array}
     */
    symmetry_plane() {
        const ret = wasm.denturereviewresult_symmetry_plane(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * The mesh face each tip stands on, in `tips` order.
     * @returns {Uint32Array}
     */
    tip_faces() {
        const ret = wasm.denturereviewresult_tip_faces(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Generated tips, `x y z nx ny nz stream` each (0 low, 1 area, 4 rim, 5 hole, 6 island).
     * @returns {Float64Array}
     */
    tips() {
        const ret = wasm.denturereviewresult_tips(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Tips the final guard refused (`overhangAngleDeg`, engine 39), `[rim, hole, area, other]`.
     * @returns {Uint32Array}
     */
    tips_dropped_facing_up() {
        const ret = wasm.denturereviewresult_tips_dropped_facing_up(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * `socketNoSupport`: tips kept off sockets [rim, hole, area, other].
     * @returns {Uint32Array}
     */
    tips_dropped_socket() {
        const ret = wasm.denturereviewresult_tips_dropped_socket(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Tips skipped for a knife-sharp fold or a neck that would enter the material behind a nearby face (engine 39), `[rim, hole, area, other]`.
     * @returns {Uint32Array}
     */
    tips_skipped_fold() {
        const ret = wasm.denturereviewresult_tips_skipped_fold(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Tips on an overhang with no free path to the plate, same layout as `tips`; not built.
     * @returns {Float64Array}
     */
    unsupportable() {
        const ret = wasm.denturereviewresult_unsupportable(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * The oriented pose's plate normal (up) in the mesh frame, xyz.
     * @returns {Float64Array}
     */
    up() {
        const ret = wasm.denturereviewresult_up(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * The up decision (layout in `denture/review.rs` `up_decision_values`): T1b diagnostic (box axis, decided, flipped, medians, margin, hits), up xyz, arch frame up before xyz, slice votes (for, against, abstain), confidence, top xyz, teeth flipped, back xyz, front/back margin, cross-check agrees, end widths; empty for a mesh with no box.
     * @returns {Float64Array}
     */
    up_decision() {
        const ret = wasm.denturereviewresult_up_decision(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
}
if (Symbol.dispose) DentureReviewResult.prototype[Symbol.dispose] = DentureReviewResult.prototype.free;

/**
 * One tilt's tips with their path states. Failed: `ok() == false` with `reason()`.
 */
export class DentureTiltPaths {
    static __wrap(ptr) {
        const obj = Object.create(DentureTiltPaths.prototype);
        obj.__wbg_ptr = ptr;
        DentureTiltPathsFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        DentureTiltPathsFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_denturetiltpaths_free(ptr, 0);
    }
    /**
     * Lowest points without a path, tips without a path, tips with only a fallback path, tips.
     * @returns {Uint32Array}
     */
    counts() {
        const ret = wasm.denturetiltpaths_counts(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @returns {boolean}
     */
    ok() {
        const ret = wasm.denturetiltpaths_ok(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Area (mm2) of the faces steeper than the overhang angle at this tilt.
     * @returns {number}
     */
    overhang_mm2() {
        const ret = wasm.denturetiltpaths_overhang_mm2(this.__wbg_ptr);
        return ret;
    }
    /**
     * Why the call could not run (`invalid-scan-input` or an upright reason `orientation-...`); empty when ok.
     * @returns {string}
     */
    reason() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.denturetiltpaths_reason(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Euler XYZ (radians) turning the mesh into this print pose.
     * @returns {Float64Array}
     */
    rotation() {
        const ret = wasm.denturetiltpaths_rotation(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Per tip, same order: 0 path, 1 fallback, 2 none.
     * @returns {Uint8Array}
     */
    states() {
        const ret = wasm.denturetiltpaths_states(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * The tips (mesh frame): `x y z nx ny nz stream` each (stream 0 low, 1 area, 4 rim, 5 hole, 6 island).
     * @returns {Float64Array}
     */
    tips() {
        const ret = wasm.denturetiltpaths_tips(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
}
if (Symbol.dispose) DentureTiltPaths.prototype[Symbol.dispose] = DentureTiltPaths.prototype.free;

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
     * Rule `contactFit` (engine 45): the built contact ends by fit state `[fitted, seat, unconverged]`; zeros with the rule off.
     * @returns {Uint32Array}
     */
    contact_fits() {
        const ret = wasm.generation_contact_fits(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
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
     * The full sentence when the time rule stopped the build ("stopped: no progress for 30 s"); empty otherwise.
     * @returns {string}
     */
    stop_reason() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.generation_stop_reason(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
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
     * The case's footprint on the plate (engine 53, `supports::plate::footprint`), as `arrange_plate` reads one case: the loop count,
     * then per loop its point count and x z per point (plate plan, mm, largest loop first); `[0]` without a model.
     * @returns {Float64Array}
     */
    take_footprint() {
        const ret = wasm.generation_take_footprint(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
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
     * Last-resort tips: the pillar clearance (mm) each was judged and verified at.
     * @returns {Float64Array}
     */
    take_last_resort_clearances() {
        const ret = wasm.generation_take_last_resort_clearances(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Tips the last-resort tier placed (denture builds): ids.
     * @returns {string[]}
     */
    take_last_resort_ids() {
        const ret = wasm.generation_take_last_resort_ids(this.__wbg_ptr);
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Last-resort tips: the tier of each (1 the outline lean limit relaxed, 2 the clearance stepped down as well).
     * @returns {Uint8Array}
     */
    take_last_resort_tiers() {
        const ret = wasm.generation_take_last_resort_tiers(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Left-out contacts with a reason: ids.
     * @returns {string[]}
     */
    take_left_out_ids() {
        const ret = wasm.generation_take_left_out_ids(this.__wbg_ptr);
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Left-out contacts: x y z of each tip (plate frame, mm).
     * @returns {Float64Array}
     */
    take_left_out_points() {
        const ret = wasm.generation_take_left_out_points(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Left-out contacts: the reason of each, `step` or `step:part` (build-omission, leave-out:pillar, leave-out:neck, all-manual, structures-off-leave-out, structure-fallback).
     * @returns {string[]}
     */
    take_left_out_reasons() {
        const ret = wasm.generation_take_left_out_reasons(this.__wbg_ptr);
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Tips supported from the model's own surface (dental option `dentalModelLanding` / the allow list): ids.
     * @returns {string[]}
     */
    take_model_landed_ids() {
        const ret = wasm.generation_take_model_landed_ids(this.__wbg_ptr);
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Model-landed tips: x y z of each landing point (plate frame, mm).
     * @returns {Float64Array}
     */
    take_model_landed_points() {
        const ret = wasm.generation_take_model_landed_points(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Model-landed tips: the landing tier of each (1 allowed area, 2 other surface, 3 no-support zone).
     * @returns {Uint8Array}
     */
    take_model_landed_tiers() {
        const ret = wasm.generation_take_model_landed_tiers(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
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
     * Unresolved report: the best gap (mm) at which a route from the plate was found, NaN when none was found or searched.
     * @returns {Float64Array}
     */
    take_unresolved_best_gaps() {
        const ret = wasm.generation_take_unresolved_best_gaps(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Unresolved report (every tip still left out and every island no support reaches): ids (`island-<vertex>` for an island with no tip).
     * @returns {string[]}
     */
    take_unresolved_ids() {
        const ret = wasm.generation_take_unresolved_ids(this.__wbg_ptr);
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Unresolved report (engine 51): what each entry is, `island`, `lowest` (a lowest-point tip left out, or a lowest point with no tip) or `tip`.
     * @returns {string[]}
     */
    take_unresolved_kinds() {
        const ret = wasm.generation_take_unresolved_kinds(this.__wbg_ptr);
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Unresolved report: the gap (mm) the build needs, per entry.
     * @returns {Float64Array}
     */
    take_unresolved_needed() {
        const ret = wasm.generation_take_unresolved_needed(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Unresolved report (engine 51): the outward surface normal per entry, xyz (plate frame; an island: straight down), for `reroute_support`.
     * @returns {Float64Array}
     */
    take_unresolved_normals() {
        const ret = wasm.generation_take_unresolved_normals(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Unresolved report: x y z of each (plate frame, mm; the height above the plate is y minus the plate's).
     * @returns {Float64Array}
     */
    take_unresolved_points() {
        const ret = wasm.generation_take_unresolved_points(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Unresolved report: why, in words.
     * @returns {string[]}
     */
    take_unresolved_reasons() {
        const ret = wasm.generation_take_unresolved_reasons(this.__wbg_ptr);
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Unresolved report: the stream of each (low, area, bar, light, rim, hole, island; empty for a tip of another policy).
     * @returns {string[]}
     */
    take_unresolved_streams() {
        const ret = wasm.generation_take_unresolved_streams(this.__wbg_ptr);
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]);
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
     * The rim for a hand-drawn loop, for an aligner whose rim detection found none: the same
     * scalars, loop points and 96 x 96 visibility mask an orient result carries, built by the same
     * rasteriser. Which way the opening faces comes from the floor rule detection itself uses, not
     * from the loop's winding, and `floor_offset()` reports the measurement behind it.
     * @param {number} model
     * @param {Float32Array} points
     * @param {boolean} flip
     * @param {string} profile
     * @returns {DentalRimResult}
     */
    dental_rim_from_points(model, points, flip, profile) {
        const ptr0 = passArrayF32ToWasm0(points, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(profile, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.geometrysession_dental_rim_from_points(this.__wbg_ptr, model, ptr0, len0, flip, ptr1, len1);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return DentalRimResult.__wrap(ret[0]);
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
     * Classes every face by whether it lies within `radius_mm` of the owner points, of the generated points, of both or neither.
     * @param {number} model
     * @param {Float64Array} owner
     * @param {Float64Array} generated
     * @param {number} radius_mm
     * @returns {DentureAreaResult}
     */
    denture_compare_areas(model, owner, generated, radius_mm) {
        const ptr0 = passArrayF64ToWasm0(owner, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF64ToWasm0(generated, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.geometrysession_denture_compare_areas(this.__wbg_ptr, model, ptr0, len0, ptr1, len1, radius_mm);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return DentureAreaResult.__wrap(ret[0]);
    }
    /**
     * The denture policy of a unit as a `PolicyResult` for `generate`: every face permitted, the
     * pose's tips as candidates (lowest points, bottom band, bars, light fill), pillars may land on
     * the model, Tree off, Brace by `brace`. `frame` is the unit's placement `[position xyz,
     * rotation xyz]` the result is expressed in (its +Y is the plate normal the tips are placed
     * for); `manual_positions` the unit's manual tips (unit-local xyz triples) to keep clear of.
     * @param {number} model
     * @param {string} profile
     * @param {Float64Array} frame
     * @param {boolean} brace
     * @param {Float64Array} manual_positions
     * @returns {PolicyHandle}
     */
    denture_policy(model, profile, frame, brace, manual_positions) {
        const ptr0 = passStringToWasm0(profile, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF64ToWasm0(frame, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArrayF64ToWasm0(manual_positions, wasm.__wbindgen_malloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.geometrysession_denture_policy(this.__wbg_ptr, model, ptr0, len0, ptr1, len1, brace, ptr2, len2);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return PolicyHandle.__wrap(ret[0]);
    }
    /**
     * [`denture_policy`] with the host's rule overrides (`rules`, one entry per name of `rule_names()`; a missing or NaN entry keeps
     * Rust's default). The rules `islandTips`, `islandMinAreaMm2`, `lowOutsideAllowed`, `islandReuseMm` and `islandSlabMm` apply: an
     * island tip (candidate source "island") stands at the lowest vertex of each island of the pose, and the handle's
     * `island_facts()` reports every island.
     * @param {number} model
     * @param {string} profile
     * @param {Float64Array} frame
     * @param {boolean} brace
     * @param {Float64Array} manual_positions
     * @param {Float64Array} rules
     * @returns {PolicyHandle}
     */
    denture_policy_ruled(model, profile, frame, brace, manual_positions, rules) {
        const ptr0 = passStringToWasm0(profile, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF64ToWasm0(frame, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArrayF64ToWasm0(manual_positions, wasm.__wbindgen_malloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passArrayF64ToWasm0(rules, wasm.__wbindgen_malloc);
        const len3 = WASM_VECTOR_LEN;
        const ret = wasm.geometrysession_denture_policy_ruled(this.__wbg_ptr, model, ptr0, len0, ptr1, len1, brace, ptr2, len2, ptr3, len3);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return PolicyHandle.__wrap(ret[0]);
    }
    /**
     * The review layers of the owner denture rules on a loaded mesh (independent of its import orientation) at the print tilt `tilt_deg` (0 = canonical).
     * @param {number} model
     * @param {string} profile
     * @param {number} tilt_deg
     * @returns {DentureReviewResult | undefined}
     */
    denture_review(model, profile, tilt_deg) {
        const ptr0 = passStringToWasm0(profile, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.geometrysession_denture_review(this.__wbg_ptr, model, ptr0, len0, tilt_deg);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] === 0 ? undefined : DentureReviewResult.__wrap(ret[0]);
    }
    /**
     * [`denture_review`] with the host's rule overrides (`rules`, `rule_names()` order; empty keeps the defaults): the island tips and the low-tip admission (`lowOutsideAllowed`) apply.
     * @param {number} model
     * @param {string} profile
     * @param {number} tilt_deg
     * @param {Float64Array} rules
     * @returns {DentureReviewResult | undefined}
     */
    denture_review_ruled(model, profile, tilt_deg, rules) {
        const ptr0 = passStringToWasm0(profile, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF64ToWasm0(rules, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.geometrysession_denture_review_ruled(this.__wbg_ptr, model, ptr0, len0, tilt_deg, ptr1, len1);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] === 0 ? undefined : DentureReviewResult.__wrap(ret[0]);
    }
    /**
     * The live tilt view (engine 32): the tips of one print tilt with, per tip, whether a support has a way down by the landing circle
     * (`path` 0, `fallback` 1, `none` 2), and no supports built. The per-model work (rim, holes, masks, ray index, upright frame) is
     * cached by the engine per model, so after the first call a tilt costs tens of milliseconds. `rules` as `denture_tilt_scan_ruled`.
     * @param {number} model
     * @param {string} profile
     * @param {number} tilt_deg
     * @param {number} neck_length_mm
     * @param {number} pillar_diameter_mm
     * @param {number} lift_mm
     * @param {boolean} braced
     * @param {Float64Array} rules
     * @returns {DentureTiltPaths}
     */
    denture_tilt_paths(model, profile, tilt_deg, neck_length_mm, pillar_diameter_mm, lift_mm, braced, rules) {
        const ptr0 = passStringToWasm0(profile, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF64ToWasm0(rules, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.geometrysession_denture_tilt_paths(this.__wbg_ptr, model, ptr0, len0, tilt_deg, neck_length_mm, pillar_diameter_mm, lift_mm, braced, ptr1, len1);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return DentureTiltPaths.__wrap(ret[0]);
    }
    /**
     * Print-angle search of a denture from upright over the profile's range, with the host's
     * current support settings; rows as `dental_tilt_scan` (fitting-side tips and rim gap are 0).
     * `on_tilt(done, total)`, when given, is called after each scanned tilt. The default support
     * rules apply (`denture_tilt_scan_ruled` takes the host's).
     * @param {number} model
     * @param {string} profile
     * @param {number} neck_length_mm
     * @param {number} pillar_diameter_mm
     * @param {number} lift_mm
     * @param {boolean} braced
     * @param {Function | null} [on_tilt]
     * @returns {DentalTiltScanResult}
     */
    denture_tilt_scan(model, profile, neck_length_mm, pillar_diameter_mm, lift_mm, braced, on_tilt) {
        const ptr0 = passStringToWasm0(profile, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.geometrysession_denture_tilt_scan(this.__wbg_ptr, model, ptr0, len0, neck_length_mm, pillar_diameter_mm, lift_mm, braced, isLikeNone(on_tilt) ? 0 : addToExternrefTable0(on_tilt));
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return DentalTiltScanResult.__wrap(ret[0]);
    }
    /**
     * [`denture_tilt_scan`] with the host's support-rule overrides (`rules`, one entry per name of `rule_names()`; a missing or NaN
     * entry keeps Rust's default). The rule `boxedInTiltWeight` (default 1) makes the pick prefer the tilt with the fewest lowest
     * points no support can reach; 0 turns that off. The result then also carries `boxed_counts()` (per row), `boxed_points()` and
     * `boxed_reasons()` (the picked row's boxed-in points).
     * @param {number} model
     * @param {string} profile
     * @param {number} neck_length_mm
     * @param {number} pillar_diameter_mm
     * @param {number} lift_mm
     * @param {boolean} braced
     * @param {Float64Array} rules
     * @param {Function | null} [on_tilt]
     * @returns {DentalTiltScanResult}
     */
    denture_tilt_scan_ruled(model, profile, neck_length_mm, pillar_diameter_mm, lift_mm, braced, rules, on_tilt) {
        const ptr0 = passStringToWasm0(profile, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF64ToWasm0(rules, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.geometrysession_denture_tilt_scan_ruled(this.__wbg_ptr, model, ptr0, len0, neck_length_mm, pillar_diameter_mm, lift_mm, braced, ptr1, len1, isLikeNone(on_tilt) ? 0 : addToExternrefTable0(on_tilt));
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
     * Step 1 evidence layers of a loaded aligner (`dental::review_orientation`): the detected trim
     * chains, the two U ends, the bottom plane's outline and the back arrow. Review only.
     * @param {number} model
     * @param {number} revision
     * @param {string} profile
     * @returns {Diagnosis}
     */
    diagnose_orientation(model, revision, profile) {
        const ptr0 = passStringToWasm0(profile, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.geometrysession_diagnose_orientation(this.__wbg_ptr, model, revision, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Diagnosis.__wrap(ret[0]);
    }
    /**
     * A policy with nothing in it, for a live edit call that does not use the policy (`reroute_support` with `allow_model_landing` false).
     * @returns {PolicyHandle}
     */
    empty_policy() {
        const ret = wasm.geometrysession_empty_policy(this.__wbg_ptr);
        return PolicyHandle.__wrap(ret);
    }
    /**
     * The support pipeline for a plate-space model: `contacts` and `shapes` as `build_supports`,
     * `policy` the unit's policy as Rust made it (same frame as the model). `limits` overrides the time rule
     * (`supports::time_limits::TimeRules::from_overrides`: base, per tip, per 100k triangles, stall, ceiling; ms; a missing or NaN
     * entry keeps the default, an empty array keeps them all). The build gets a start allowance by size, is extended while it
     * progresses, and stops with an inconclusive verdict (never a clear one) after the stall window or at the ceiling;
     * `stop_reason()` then holds the sentence. `rules` overrides the planner's rules (`supports::rules::SupportRules::from_overrides`,
     * one entry per name of `rule_names()`; a missing or NaN entry keeps Rust's default). `plate_y` is the
     * plate's height in the model's frame: 0 for a model placed on the plate; a lift change keeps the
     * placed model (and its caches) and moves the plate instead. Island heights are above the plate.
     * `on_phase` (optional, engine 60) is called as `(phase, done, total)` at each phase of the build (`supports::phase::Phase::name`: preparing,
     * routing, placing, bracing, raft, checking, judging, finishing, writing); `total` is 0 at a phase's entry and the tips counted in routing and placing;
     * a repair round can repeat the build phases. It changes nothing in the result.
     * @param {number} model
     * @param {string[]} ids
     * @param {Float64Array} contacts
     * @param {Float64Array} shapes
     * @param {Float64Array} settings
     * @param {number} mode
     * @param {string} label_text
     * @param {Float64Array} zones
     * @param {PolicyHandle} policy
     * @param {Float64Array} limits
     * @param {Float64Array} rules
     * @param {number} revision
     * @param {number} plate_y
     * @param {Float64Array} frame
     * @param {Function | null} [on_phase]
     * @returns {Generation}
     */
    generate(model, ids, contacts, shapes, settings, mode, label_text, zones, policy, limits, rules, revision, plate_y, frame, on_phase) {
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
        const ptr6 = passArrayF64ToWasm0(limits, wasm.__wbindgen_malloc);
        const len6 = WASM_VECTOR_LEN;
        const ptr7 = passArrayF64ToWasm0(rules, wasm.__wbindgen_malloc);
        const len7 = WASM_VECTOR_LEN;
        const ptr8 = passArrayF64ToWasm0(frame, wasm.__wbindgen_malloc);
        const len8 = WASM_VECTOR_LEN;
        const ret = wasm.geometrysession_generate(this.__wbg_ptr, model, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, mode, ptr4, len4, ptr5, len5, policy.__wbg_ptr, ptr6, len6, ptr7, len7, revision, plate_y, ptr8, len8, isLikeNone(on_phase) ? 0 : addToExternrefTable0(on_phase));
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Generation.__wrap(ret[0]);
    }
    /**
     * Automatic contacts of a loaded model (already in the frame they are wanted in). `rules` (optional, engine 47): the
     * `supports::rules::NAMES` override array (`areaDensity`, the edge rules); absent or NaN entries keep the engine defaults.
     * @param {number} model
     * @param {Float64Array} settings
     * @param {Float64Array | null} [rules]
     * @returns {GenericPlacement}
     */
    generic_place(model, settings, rules) {
        const ptr0 = passArrayF64ToWasm0(settings, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        var ptr1 = isLikeNone(rules) ? 0 : passArrayF64ToWasm0(rules, wasm.__wbindgen_malloc);
        var len1 = WASM_VECTOR_LEN;
        const ret = wasm.geometrysession_generic_place(this.__wbg_ptr, model, ptr0, len0, ptr1, len1);
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
     * Step 1 for a denture: the upright frame (arch plane vertical, legs down, teeth side) and its rotation.
     * @param {number} model
     * @param {string} profile
     * @returns {DentureOrientResult}
     */
    orient_denture(model, profile) {
        const ptr0 = passStringToWasm0(profile, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.geometrysession_orient_denture(this.__wbg_ptr, model, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return DentureOrientResult.__wrap(ret[0]);
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
     * Where the pillar of that support may stand (`skeleton::edit::pillar_reach`): a grid mask around the
     * tip, `radius_mm` out at `grid_mm` a cell; `judged` false gives the cheap space-map answer, true judges
     * every cell's support. `take_pieces()` holds [x0, z0, cell, nx, nz, then nx*nz cells as 0/1, row by row].
     * @param {number} model
     * @param {Float64Array} settings
     * @param {Float64Array} rules
     * @param {Float64Array} tip
     * @param {Float64Array} normal
     * @param {number} plate_y
     * @param {number} radius_mm
     * @param {number} grid_mm
     * @param {boolean} judged
     * @returns {Reroute}
     */
    pillar_reach(model, settings, rules, tip, normal, plate_y, radius_mm, grid_mm, judged) {
        const ptr0 = passArrayF64ToWasm0(settings, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF64ToWasm0(rules, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArrayF64ToWasm0(tip, wasm.__wbindgen_malloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passArrayF64ToWasm0(normal, wasm.__wbindgen_malloc);
        const len3 = WASM_VECTOR_LEN;
        const ret = wasm.geometrysession_pillar_reach(this.__wbg_ptr, model, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, plate_y, radius_mm, grid_mm, judged);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Reroute.__wrap(ret[0]);
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
     * Live edit of one support (`skeleton::edit::reroute_support`): the tip at `tip` (xyz, plate frame)
     * with outward `normal`, its pillar dragged to plan (`x`, `z`); `settings` and `rules` as `generate`'s
     * (the capsule judge's margin comes from the rules). The result's `take_pieces()` is the skeleton, nine
     * numbers per piece: kind (0 tip cone, 1 neck, 2 rod, 3 transition, 4 trunk, 5 joint, 6 brace, 7 foot),
     * the piece's two points (xyz each; a joint or foot repeats its point) and its two radii (mm). Empty
     * with `refusal()` naming the rule that refused (too far, under the floor, clearance). With `allow_model_landing` (dental option) a spot the plate
     * route refuses, or no spot (`x` or `z` NaN), falls to a column that ends on the model's own surface (best tier first: allowed area, other surface,
     * no-support zone): `landing_tier()` is then 1, 2 or 3 and `landing_point()` holds the landing; `policy` supplies the tier masks and `zones`
     * (`packZones`) the painted no-support stamps. Otherwise `policy` and `zones` are ignored (`empty_policy()`, an empty array).
     * @param {number} model
     * @param {Float64Array} settings
     * @param {Float64Array} rules
     * @param {Float64Array} tip
     * @param {Float64Array} normal
     * @param {number} x
     * @param {number} z
     * @param {number} plate_y
     * @param {boolean} allow_model_landing
     * @param {PolicyHandle} policy
     * @param {Float64Array} zones
     * @returns {Reroute}
     */
    reroute_support(model, settings, rules, tip, normal, x, z, plate_y, allow_model_landing, policy, zones) {
        const ptr0 = passArrayF64ToWasm0(settings, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF64ToWasm0(rules, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArrayF64ToWasm0(tip, wasm.__wbindgen_malloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passArrayF64ToWasm0(normal, wasm.__wbindgen_malloc);
        const len3 = WASM_VECTOR_LEN;
        _assertClass(policy, PolicyHandle);
        const ptr4 = passArrayF64ToWasm0(zones, wasm.__wbindgen_malloc);
        const len4 = WASM_VECTOR_LEN;
        const ret = wasm.geometrysession_reroute_support(this.__wbg_ptr, model, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, x, z, plate_y, allow_model_landing, policy.__wbg_ptr, ptr4, len4);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Reroute.__wrap(ret[0]);
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
 * The diagnosis of one mesh: what the file is, with nothing changed.
 */
export class MeshDiagnosis {
    static __wrap(ptr) {
        const obj = Object.create(MeshDiagnosis.prototype);
        obj.__wbg_ptr = ptr;
        MeshDiagnosisFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        MeshDiagnosisFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_meshdiagnosis_free(ptr, 0);
    }
    /**
     * `BODY_SCALARS` values per physical body, in body id order (moved out).
     * @returns {Float64Array}
     */
    take_bodies() {
        const ret = wasm.meshdiagnosis_take_bodies(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * `LOOP_SCALARS` values per boundary loop (moved out).
     * @returns {Float64Array}
     */
    take_loops() {
        const ret = wasm.meshdiagnosis_take_loops(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * The whole-mesh roll-up, `MESH_SCALARS` values (moved out).
     * @returns {Float64Array}
     */
    take_mesh() {
        const ret = wasm.meshdiagnosis_take_mesh(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
}
if (Symbol.dispose) MeshDiagnosis.prototype[Symbol.dispose] = MeshDiagnosis.prototype.free;

/**
 * The result of a repair: the mesh plus the report of every step.
 */
export class MeshRepairResult {
    static __wrap(ptr) {
        const obj = Object.create(MeshRepairResult.prototype);
        obj.__wbg_ptr = ptr;
        MeshRepairResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        MeshRepairResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_meshrepairresult_free(ptr, 0);
    }
    /**
     * Whether any step changed anything. False means the arrays below are the caller's own,
     * element for element (a clean mesh is returned bit-identical).
     * @returns {boolean}
     */
    changed() {
        const ret = wasm.meshrepairresult_changed(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * False when a step would have moved a face between physical bodies: the repair was abandoned
     * and `take_positions` / `take_indices` give the file back exactly as it came in. A normal
     * result, not a throw; `reason` names the step. The `before` report is filled either way.
     * @returns {boolean}
     */
    ok() {
        const ret = wasm.meshrepairresult_ok(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Empty when `ok`. Otherwise `body-invariant:<step>`, the step being `weld`, `degenerate`,
     * `manifold` or `winding`.
     * @returns {string}
     */
    reason() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.meshrepairresult_reason(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * The file as it leaves repair: `MESH_SCALARS` values (moved out).
     * @returns {Float64Array}
     */
    take_after() {
        const ret = wasm.meshrepairresult_take_after(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * The file as it came in: `MESH_SCALARS` values (moved out).
     * @returns {Float64Array}
     */
    take_before() {
        const ret = wasm.meshrepairresult_take_before(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Bodies after repair, `BODY_SCALARS` each (moved out).
     * @returns {Float64Array}
     */
    take_bodies_after() {
        const ret = wasm.meshrepairresult_take_bodies_after(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Bodies before repair, `BODY_SCALARS` each (moved out).
     * @returns {Float64Array}
     */
    take_bodies_before() {
        const ret = wasm.meshrepairresult_take_bodies_before(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Every boundary loop the fill step looked at, `FILL_SCALARS` values each (moved out): whether
     * it was closed and, when it was not, why. Empty when not `ok`.
     * @returns {Float64Array}
     */
    take_fills() {
        const ret = wasm.meshrepairresult_take_fills(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * The repaired indices, u32 triangle triples (moved out).
     * @returns {Uint32Array}
     */
    take_indices() {
        const ret = wasm.meshrepairresult_take_indices(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Boundary loops left after repair, `LOOP_SCALARS` each (moved out).
     * @returns {Float64Array}
     */
    take_loops_after() {
        const ret = wasm.meshrepairresult_take_loops_after(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Boundary loops before repair, `LOOP_SCALARS` each (moved out).
     * @returns {Float64Array}
     */
    take_loops_before() {
        const ret = wasm.meshrepairresult_take_loops_before(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * The repaired positions, f32 xyz triples (moved out).
     * @returns {Float32Array}
     */
    take_positions() {
        const ret = wasm.meshrepairresult_take_positions(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * What each step did: `STEP_SCALARS` values (moved out). All zero when not `ok`.
     * @returns {Float64Array}
     */
    take_steps() {
        const ret = wasm.meshrepairresult_take_steps(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
}
if (Symbol.dispose) MeshRepairResult.prototype[Symbol.dispose] = MeshRepairResult.prototype.free;

/**
 * Tips per part, plus what the operator has to be shown to understand them.
 */
export class PartTipsResult {
    static __wrap(ptr) {
        const obj = Object.create(PartTipsResult.prototype);
        obj.__wbg_ptr = ptr;
        PartTipsResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        PartTipsResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_parttipsresult_free(ptr, 0);
    }
    /**
     * Part id of each file face.
     * @returns {Uint32Array}
     */
    take_face_parts() {
        const ret = wasm.parttipsresult_take_face_parts(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * 1 where a file face is buried inside another part. This is what the viewport tints, and what
     * lets the app tell an operator WHY a face got no tip.
     * @returns {Uint8Array}
     */
    take_hidden() {
        const ret = wasm.parttipsresult_take_hidden(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * `part<N>-<position id>`, one per tip, in part order.
     * @returns {string[]}
     */
    take_ids() {
        const ret = wasm.parttipsresult_take_ids(this.__wbg_ptr);
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Tip normals, xyz f64 — what the neck is aimed by.
     * @returns {Float64Array}
     */
    take_normals() {
        const ret = wasm.parttipsresult_take_normals(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * `PART_STRIDE` numbers per part: id, role, triangles, volume mm3, area mm2, tips. The same row
     * shape the dental parts list uses, so a host that decodes one decodes both.
     * @returns {Float64Array}
     */
    take_part_list() {
        const ret = wasm.parttipsresult_take_part_list(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Tip points, xyz f64.
     * @returns {Float64Array}
     */
    take_positions() {
        const ret = wasm.parttipsresult_take_positions(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * The file face each tip stands on.
     * @returns {Uint32Array}
     */
    take_tip_faces() {
        const ret = wasm.parttipsresult_take_tip_faces(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Which part each tip belongs to. Without this a host cannot attribute a tip.
     * @returns {Uint32Array}
     */
    take_tip_parts() {
        const ret = wasm.parttipsresult_take_tip_parts(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
}
if (Symbol.dispose) PartTipsResult.prototype[Symbol.dispose] = PartTipsResult.prototype.free;

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
 * The layout: a new plan offset per case and which cases moved, fit nowhere, or overlap while frozen.
 */
export class PlateArrangement {
    static __wrap(ptr) {
        const obj = Object.create(PlateArrangement.prototype);
        obj.__wbg_ptr = ptr;
        PlateArrangementFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        PlateArrangementFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_platearrangement_free(ptr, 0);
    }
    /**
     * Indices of the frozen cases that overlap an earlier frozen case or leave the plate.
     * @returns {Uint32Array}
     */
    conflicts() {
        const ret = wasm.platearrangement_conflicts(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Indices of the cases that moved.
     * @returns {Uint32Array}
     */
    moved() {
        const ret = wasm.platearrangement_moved(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * x z per case (plan, mm), input order.
     * @returns {Float64Array}
     */
    offsets() {
        const ret = wasm.platearrangement_offsets(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Indices of the unfrozen cases that fit nowhere (left where they were).
     * @returns {Uint32Array}
     */
    unplaced() {
        const ret = wasm.platearrangement_unplaced(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
}
if (Symbol.dispose) PlateArrangement.prototype[Symbol.dispose] = PlateArrangement.prototype.free;

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
     * A dental policy's part id of every face of the file (the layer "Parts"); empty for any other policy.
     * @returns {Uint32Array}
     */
    face_parts() {
        const ret = wasm.policyhandle_face_parts(this.__wbg_ptr);
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * A denture policy's islands, 9 numbers each (x y z, height above the pose's lowest vertex mm, footprint mm2, distance to the nearest planned tip mm or -1, state 0 tipped / 1 served by a tip nearby / 2 below min size / 3 in no-support zone / 4 outside allowed area / 5 no usable face, index of the serving candidate or -1, face or -1). Empty for any other policy or with the rule `islandTips` off.
     * @returns {Float64Array}
     */
    island_facts() {
        const ret = wasm.policyhandle_island_facts(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Why a denture policy could not tell its islands (the surface is not a clean manifold...); empty when it could.
     * @returns {string}
     */
    islands_note() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.policyhandle_islands_note(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
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
     * A dental policy's parts (dentures engine 50, aligners engine 56), 6 numbers each: part id, role (0 target: the dental tips;
     * 1 add-on: generic tips on its own faces; 2 debris: no tips; 3 fused: joined to the target, printed with it, generic tips
     * on its exposed faces only), triangles, volume mm3, area mm2, candidates placed on it. Empty for any other policy.
     * @returns {Float64Array}
     */
    part_list() {
        const ret = wasm.policyhandle_part_list(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
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
     * Local lows of the dental rim whose face points up: no tip (rule `rimLowNeedsOverhang`), counted apart from the left-out tips; 0 for any other policy.
     * @returns {number}
     */
    rim_lows_facing_up() {
        const ret = wasm.policyhandle_rim_lows_facing_up(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    ring_count() {
        const ret = wasm.policyhandle_ring_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * The dental model-landing allow list (tip ids): those tips may be supported from the model's own surface even when the rule
     * `dentalModelLanding` is 0 (denture builds only; replaces the earlier list). The UI bubble "support from model surface" fills it.
     * An id of a lowest point the policy placed no tip on (`denture-low-unreached-<k>`, the unresolved report's `lowest` entries with
     * no tip) also makes that point a candidate (engine 51, `dental::denture::model_landing::admit`). An island id (`island-<vertex>`, the
     * report's bare islands) makes `generate` put a tip at that island's lowest vertex when it faces within `islandOverhangAngleDeg` of
     * straight down (engine 54, `supports::generate::island_admit`).
     * @param {string[]} ids
     */
    set_model_landing_allow(ids) {
        const ptr0 = passArrayJsValueToWasm0(ids, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.policyhandle_set_model_landing_allow(this.__wbg_ptr, ptr0, len0);
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
 * The answer of a live edit (`GeometrySession::reroute_support`, `pillar_reach`): a flat number array and, for a refused reroute, the reason.
 */
export class Reroute {
    static __wrap(ptr) {
        const obj = Object.create(Reroute.prototype);
        obj.__wbg_ptr = ptr;
        RerouteFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RerouteFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_reroute_free(ptr, 0);
    }
    /**
     * x y z of the landing on the model (plate frame, mm); empty when the support reaches the plate.
     * @returns {Float64Array}
     */
    landing_point() {
        const ret = wasm.reroute_landing_point(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * 0 the support reaches the plate; 1, 2, 3 it lands on the model (allowed area, other surface, no-support zone).
     * @returns {number}
     */
    landing_tier() {
        const ret = wasm.reroute_landing_tier(this.__wbg_ptr);
        return ret;
    }
    /**
     * Why the reroute was refused; empty when it was taken.
     * @returns {string}
     */
    refusal() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.reroute_refusal(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * The flat array (see the call that made it); taken once.
     * @returns {Float64Array}
     */
    take_pieces() {
        const ret = wasm.reroute_take_pieces(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
}
if (Symbol.dispose) Reroute.prototype[Symbol.dispose] = Reroute.prototype.free;

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
 * Packs the cases on a `width_mm` x `depth_mm` plate centred on the origin. `loops` per case: the loop count, then per loop its point
 * count and x z per point (relative to the case's offset); `offsets` x z per case; `frozen` one 0/1 per case. `full` re-packs every
 * unfrozen case; otherwise only those that do not fit where they are move. `rules` in `rule_names()` order (`plateGapMm`).
 * @param {number} width_mm
 * @param {number} depth_mm
 * @param {Float64Array} rules
 * @param {Float64Array} loops
 * @param {Float64Array} offsets
 * @param {Uint8Array} frozen
 * @param {boolean} full
 * @returns {PlateArrangement}
 */
export function arrange_plate(width_mm, depth_mm, rules, loops, offsets, frozen, full) {
    const ptr0 = passArrayF64ToWasm0(rules, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(loops, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayF64ToWasm0(offsets, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArray8ToWasm0(frozen, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ret = wasm.arrange_plate(width_mm, depth_mm, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, full);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return PlateArrangement.__wrap(ret[0]);
}

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
 * @returns {string[]}
 */
export function denture_profile_ids() {
    const ret = wasm.denture_profile_ids();
    var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]);
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v1;
}

/**
 * What a mesh is, body by body: the diagnosis that replaces the dental `mesh_ok` bit. Changes
 * nothing and allocates no mesh.
 * @param {Float32Array} positions
 * @param {Uint32Array} indices
 * @returns {MeshDiagnosis}
 */
export function diagnose_mesh(positions, indices) {
    const ptr0 = passArrayF32ToWasm0(positions, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray32ToWasm0(indices, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.diagnose_mesh(ptr0, len0, ptr1, len1);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return MeshDiagnosis.__wrap(ret[0]);
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
 * Tips on every part's exposed faces.
 *
 * `target` is the host's declared target part, or `-1` to let the engine pick the largest. It is
 * here rather than added later on purpose: the engine ranks by volume, the operator's active object
 * is not necessarily that part, and in an editor a merge makes the active object the lead. Only the
 * host can settle the three.
 *
 * A `debris` part gets no tips, which is a DENTAL judgement about scan noise; a generic caller that
 * wants every part supported passes a `debris_mm` of 0.
 * @param {Float32Array} positions
 * @param {Uint32Array} indices
 * @param {Float64Array} settings
 * @param {Float64Array} rules
 * @param {number} debris_mm
 * @param {number} target
 * @returns {PartTipsResult}
 */
export function part_tips(positions, indices, settings, rules, debris_mm, target) {
    const ptr0 = passArrayF32ToWasm0(positions, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray32ToWasm0(indices, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayF64ToWasm0(settings, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArrayF64ToWasm0(rules, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ret = wasm.part_tips(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, debris_mm, target);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return PartTipsResult.__wrap(ret[0]);
}

/**
 * The build phase names `generate`'s `on_phase` callback reports, in the order a first (unrepaired)
 * build runs them (`mixo_geometry_core::supports::phase::Phase::ALL`). Engine 64, for GEO-015: the
 * host held a second hand-written copy of this list (`GENERATE_PHASES` in host/core/progress.ts)
 * and the gate between them DROPPED a name it did not know, so a phase added here without a host
 * update left the operator's bar sitting still on a build that was working fine.
 * @returns {string[]}
 */
export function phase_names() {
    const ret = wasm.phase_names();
    var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]);
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v1;
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
 * Removes collapsed triangles; the host reports the count.
 * @param {Float32Array} positions
 * @param {Uint32Array} indices
 * @returns {WeldResult}
 */
export function remove_degenerate_triangles(positions, indices) {
    const ptr0 = passArrayF32ToWasm0(positions, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray32ToWasm0(indices, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.remove_degenerate_triangles(ptr0, len0, ptr1, len1);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return WeldResult.__wrap(ret[0]);
}

/**
 * Repair on import: weld coincident vertices, drop collapsed triangles, split non-manifold edges
 * and bowtie vertices, make the winding consistent per body and outward for the closed ones, fill
 * the boundary loops `max_fill_loop_mm` allows, and mark the noise shells. Separate bodies always
 * stay separate, every patch is built from one loop's own vertices, and a loop that is not filled
 * is reported with the reason (`take_fills`). `max_fill_loop_mm` is the longest rim the caller
 * permits to be closed, in mm; 0 (or any non-positive or non-finite value) fills nothing. The
 * engine has no default for it on purpose - the number comes from measured rim lengths.
 * @param {Float32Array} positions
 * @param {Uint32Array} indices
 * @param {number} max_fill_loop_mm
 * @returns {MeshRepairResult}
 */
export function repair_mesh(positions, indices, max_fill_loop_mm) {
    const ptr0 = passArrayF32ToWasm0(positions, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray32ToWasm0(indices, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.repair_mesh(ptr0, len0, ptr1, len1, max_fill_loop_mm);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return MeshRepairResult.__wrap(ret[0]);
}

/**
 * The five stride constants above, in this order: mesh roll-up, per body, per boundary loop, step
 * array, per fill. Engine 64, for GEO-004: the host declared the same five numbers independently
 * (`host/core/repairMesh.ts`), and no gate compared them - the Rust side was proved against the
 * Rust constants and the host side against a fake that emitted whatever the host expected. Exported
 * so the host's copies are CHECKED rather than restated; `host/core/repairMesh.contract.test.ts`
 * is the consumer. Add a value to any layout here and that test goes red.
 * @returns {Uint32Array}
 */
export function repair_strides() {
    const ret = wasm.repair_strides();
    var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v1;
}

/**
 * The names of the planner rules `generate`'s `rules` array overrides, in array order
 * (`mixo_geometry_core::supports::rules::NAMES`): the host packs its overrides by these names.
 * @returns {string[]}
 */
export function rule_names() {
    const ret = wasm.rule_names();
    var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]);
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v1;
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
        __wbg_call_939a2607c4484b0b: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4) {
            const ret = arg0.call(arg1, arg2, arg3, arg4);
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
const DentalRimResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_dentalrimresult_free(ptr, 1));
const DentalTiltScanResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_dentaltiltscanresult_free(ptr, 1));
const DentureAreaResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_denturearearesult_free(ptr, 1));
const DentureLiveTiltFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_denturelivetilt_free(ptr, 1));
const DentureOrientResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_dentureorientresult_free(ptr, 1));
const DentureReviewResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_denturereviewresult_free(ptr, 1));
const DentureTiltPathsFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_denturetiltpaths_free(ptr, 1));
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
const MeshDiagnosisFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_meshdiagnosis_free(ptr, 1));
const MeshRepairResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_meshrepairresult_free(ptr, 1));
const PartTipsResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_parttipsresult_free(ptr, 1));
const PickIndexFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_pickindex_free(ptr, 1));
const PlateArrangementFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_platearrangement_free(ptr, 1));
const PolicyHandleFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_policyhandle_free(ptr, 1));
const RerouteFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_reroute_free(ptr, 1));
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

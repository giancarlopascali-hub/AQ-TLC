"""
TLC Spot Detection Server — 4 Methods
  A: LoG Blob Detection   (scikit-image)
  B: Adaptive Threshold   (scikit-image)
  C: Watershed            (scikit-image)

Server also serves index.html / app.js directly (no separate http.server needed).
Open: http://localhost:5050
"""

from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import numpy as np
import base64
from PIL import Image
import io
import hashlib
import traceback
import os
import cv2

app = Flask(__name__)
CORS(app)
STATIC_DIR = os.path.dirname(os.path.abspath(__file__))

# ── Static file serving ───────────────────────────────────────────────────────
@app.route('/')
def index():
    return send_from_directory(STATIC_DIR, 'index.html')

@app.route('/<path:filename>')
def static_files(filename):
    return send_from_directory(STATIC_DIR, filename)

@app.route('/detect/crop', methods=['POST'])
def detect_crop():
    data = request.get_json()
    img = load_image(data['image'])
    x, y, w, h = int(data['x']), int(data['y']), int(data['w']), int(data['h'])
    angle = data.get('angle', 0)
    if angle != 0:
        M = cv2.getRotationMatrix2D((img.shape[1]/2, img.shape[0]/2), np.degrees(-angle), 1.0)
        img = cv2.warpAffine(img, M, (img.shape[1], img.shape[0]))
    x1, y1 = min(x, x+w), min(y, y+h)
    x2, y2 = max(x, x+w), max(y, y+h)
    crop = img[max(0,y1):min(img.shape[0],y2), max(0,x1):min(img.shape[1],x2)]
    if crop.size == 0: return jsonify({'error': 'Invalid crop'}), 400
    _, buffer = cv2.imencode('.jpg', crop, [cv2.IMWRITE_JPEG_QUALITY, 90])
    return jsonify({'image': "data:image/jpeg;base64," + base64.b64encode(buffer).decode()})

# ── Image cache ───────────────────────────────────────────────────────────────
_cache: dict = {}

def load_image(b64str: str) -> np.ndarray:
    """Decode base64 image → uint8 BGR array, cached."""
    key = hashlib.md5(b64str.encode()).hexdigest() + "_color"
    if key not in _cache:
        raw = base64.b64decode(b64str.split(',')[-1])
        pil = Image.open(io.BytesIO(raw)).convert('RGB')
        _cache[key] = cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR)
        if len(_cache) > 40:
            del _cache[next(iter(_cache))]
    return _cache[key]

def load_gray(b64str: str) -> np.ndarray:
    """Decode base64 image → uint8 grayscale array, cached."""
    key = hashlib.md5(b64str.encode()).hexdigest() + "_gray"
    if key not in _cache:
        color = load_image(b64str)
        _cache[key] = cv2.cvtColor(color, cv2.COLOR_BGR2GRAY)
    return _cache[key]

def apply_bg_norm(gray: np.ndarray, bg_rect: list = None):
    """Normalize image based on a reference background rect [x, y, w, h]."""
    gray_f = gray.astype(np.float64) / 255.0
    bg_val = 1.0
    
    if bg_rect and len(bg_rect) == 4:
        x, y, w, h = [int(v) for v in bg_rect]
        H, W = gray.shape
        x0, y0 = max(0, x), max(0, y)
        x1, y1 = min(W, x + w), min(H, y + h)
        
        if x1 > x0 and y1 > y0:
            roi = gray_f[y0:y1, x0:x1]
            bg_val = float(np.median(roi))
            # Gain Correction: background moves to 1.0
            normed = np.clip(gray_f / (bg_val + 1e-6), 0, 1.0)
            return normed, bg_val
            
    return gray_f, bg_val

# ── Method A: LoG Blob Detection ──────────────────────────────────────────────
@app.route('/detect/log', methods=['POST'])
def detect_log():
    try:
        from skimage.feature import blob_log
        data = request.get_json()
        gray = load_gray(data['image'])
        normed, bg_v = apply_bg_norm(gray, data.get('bg_rect'))

        min_sigma   = float(data.get('min_sigma',   2.0))
        max_sigma   = float(data.get('max_sigma',  20.0))
        threshold   = float(data.get('threshold',   0.04))
        min_area    = float(data.get('min_area',    0.0))
        max_area    = float(data.get('max_area',    999999.0))
        overlap     = float(data.get('overlap',     0.5))
        num_sigma   = int(data.get('num_sigma',     10))

        gray_inv = 1.0 - normed
        blobs = blob_log(gray_inv,
                         min_sigma=min_sigma, max_sigma=max_sigma,
                         threshold=threshold, num_sigma=num_sigma, overlap=overlap)

        spots = []
        for y, x, sigma in blobs:
            r = max(2.0, sigma * np.sqrt(2))
            area = np.pi * (r ** 2)
            if area < min_area or area > max_area:
                continue
            spots.append({
                'cx':     round(float(x), 1),
                'cy':     round(float(y), 1),
                'bbox':   [max(0, int(x - r)), max(0, int(y - r)),
                           int(2 * r), int(2 * r)],
                'radius': round(float(r), 1),
            })
        return jsonify({'spots': spots, 'count': len(spots), 'bg_val': bg_v})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e), 'spots': [], 'count': 0})


# ── Method B: Adaptive Local Threshold ───────────────────────────────────────
@app.route('/detect/adaptive', methods=['POST'])
def detect_adaptive():
    try:
        from skimage.filters import threshold_local
        from skimage.morphology import disk, binary_opening
        from skimage.measure import label, regionprops

        data = request.get_json()
        gray = load_gray(data['image'])
        normed, bg_v = apply_bg_norm(gray, data.get('bg_rect'))

        block_size = int(data.get('block_size', 51))
        if block_size % 2 == 0: block_size += 1
        if block_size < 3:       block_size = 3
        
        offset   = float(data.get('offset',   0.02))
        min_area = int(data.get('min_area',   30))
        max_area = int(data.get('max_area',   999999))
        smoothing  = float(data.get('smoothing', 0.0))
        morph_disk = int(data.get('morphology',  2))

        # Pre-processing
        from skimage.filters import gaussian
        if smoothing > 0:
            normed = gaussian(normed, sigma=smoothing)

        local_thresh = threshold_local(normed, block_size=block_size,
                                       method='gaussian')
        binary = normed < (local_thresh - offset)
        if morph_disk > 0:
            binary = binary_opening(binary, footprint=disk(morph_disk))

        spots = []
        for rp in regionprops(label(binary)):
            if rp.area < min_area or rp.area > max_area:
                continue
            cy, cx = rp.centroid
            r0, c0, r1, c1 = rp.bbox
            spots.append({
                'cx':   round(float(cx), 1),
                'cy':   round(float(cy), 1),
                'bbox': [int(c0), int(r0), int(c1 - c0), int(r1 - r0)],
            })
        return jsonify({'spots': spots, 'count': len(spots), 'bg_val': bg_v})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e), 'spots': [], 'count': 0})


# ── Method C: Watershed + Median Background Correction ───────────────────────
@app.route('/detect/watershed', methods=['POST'])
def detect_watershed():
    try:
        from skimage.filters import gaussian as gf, threshold_otsu
        from skimage.morphology import disk, binary_opening
        from skimage.segmentation import watershed
        from skimage.feature import peak_local_max
        from skimage.measure import label, regionprops
        from scipy.ndimage import distance_transform_edt
        import numpy as np

        data = request.get_json()
        gray = load_gray(data['image'])
        normed, bg_v = apply_bg_norm(gray, data.get('bg_rect'))

        smoothing = float(data.get('smoothing', 2.0))
        min_dist  = int(data.get('min_dist', 25))
        offset    = float(data.get('offset', 0.0))
        min_area  = int(data.get('min_area', 30))
        max_area  = int(data.get('max_area', 9999))

        inv    = 1.0 - normed
        smoothed = gf(inv, sigma=smoothing)
        try:
            thresh = threshold_otsu(smoothed) + offset
        except: thresh = 0.5
        
        binary = (smoothed > thresh)
        binary = binary_opening(binary, footprint=disk(2))

        dist_map = distance_transform_edt(binary)
        coords = peak_local_max(dist_map, min_distance=min_dist, labels=binary.astype(np.uint8))
        
        spots = []
        if len(coords) > 0:
            import cv2
            markers = np.zeros(gray.shape, dtype=np.int32)
            markers[tuple(coords.T)] = np.arange(1, len(coords) + 1)
            ws_labels = watershed(-dist_map, markers, mask=binary)
            for rp in regionprops(ws_labels):
                if min_area <= rp.area <= max_area:
                    cy, cx = rp.centroid
                    r0, c0, r1, c1 = rp.bbox
                    
                    # Extract contour for freeform shape
                    mask_idx = (ws_labels[r0:r1, c0:c1] == rp.label).astype(np.uint8)
                    cnts, _ = cv2.findContours(mask_idx, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                    cnt_list = []
                    if len(cnts) > 0:
                        # Normalize contour to local bbox coordinates and downsample for JSON speed
                        for pt in cnts[0]:
                            cnt_list.append([int(pt[0][0]), int(pt[0][1])])
                    
                    spots.append({
                        'cx':   round(float(cx), 1),
                        'cy':   round(float(cy), 1),
                        'bbox': [int(c0), int(r0), int(c1 - c0), int(r1 - r0)],
                        'contour': cnt_list
                    })
        return jsonify({'spots': spots, 'count': len(spots), 'bg_val': bg_v})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e), 'spots': [], 'count': 0})




# ── Origin/Front Line Detection ───────────────────────────────────────────────
@app.route('/detect/lines', methods=['POST'])
def detect_lines():
    try:
        import cv2
        data = request.get_json()
        gray = load_gray(data['image'])
        H, W = gray.shape
        
        # 1. Background aware enhancement
        bg_rect = data.get('bg_rect')
        if bg_rect:
            x, y, w, h = [int(v) for v in bg_rect]
            bg_roi = gray[max(0,y):min(H,y+h), max(0,x):min(W,x+w)]
            if bg_roi.size > 0:
                bg_med = np.median(bg_roi)
                # Normalize based on background
                gray = np.clip((gray.astype(np.float32) / (bg_med + 1e-6)) * 200, 0, 255).astype(np.uint8)

        # 2. Horizontal Sobel to emphasize horizontal features
        sob = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
        sob = np.abs(sob)
        
        # 3. Horizontal Projection: Sum importance for each row
        # This will highlight rows that contain MANY horizontal edge bits
        proj = np.mean(sob, axis=1)
        
        # 4. Find peaks in the projection
        from scipy.signal import find_peaks
        peaks, props = find_peaks(proj, height=np.mean(proj)*2.0, distance=30)
        
        lines = []
        for p in peaks:
            # Create a line spanning 90% of the image width at this Y
            lines.append({
                'x1': int(W * 0.05), 'y1': int(p),
                'x2': int(W * 0.95), 'y2': int(p)
            })
            
        print(f">>> Projection Profile found {len(lines)} horizontal features", flush=True)
        return jsonify({'lines': lines})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e), 'lines': []})

# ── Optimization & Heuristic Search ──────────────────────────────────────────
@app.route('/detect/optimize', methods=['POST'])
def detect_optimize():
    try:
        data = request.get_json()
        model_type = data.get('model', 'adaptive')
        plate_boxes = data.get('plate_boxes', [])
        image_b64 = data['image']
        bg_rect = data.get('bg_rect')
        
        if not plate_boxes:
            return jsonify({'error': 'No plate boxes identified', 'spots': []})
            
        gray = load_gray(image_b64)
        H, W = gray.shape
        
        # 1. Mask image: only keep pixels inside plate boxes
        mask = np.zeros_like(gray, dtype=np.uint8)
        for b in plate_boxes:
            x1, y1 = int(b[0]), int(b[1])
            x2, y2 = int(b[2]), int(b[3])
            mask[max(0,y1):min(H,y2), max(0,x1):min(W,x2)] = 1
        
        normed, _ = apply_bg_norm(gray, bg_rect)
        masked = normed * mask
        
        best_params = {}
        max_spots = -1
        best_spots = []
        
        # Fixed ranges per user request
        min_area = 50
        max_area = 1500
        
        if model_type == 'adaptive':
            from skopt import gp_minimize
            from skopt.space import Real, Integer
            from skimage.filters import threshold_local, gaussian
            from skimage.morphology import disk, binary_opening
            from skimage.measure import label, regionprops
            
            space = [
                Real(-0.04, 0.12, name='offset'),
                Integer(11, 251, name='window'),
                Real(0.0, 5.0, name='smoothing')
            ]
            footprint = disk(2)
            
            def objective(params):
                off, win, sm = params
                if win % 2 == 0: win += 1
                c_img = (gaussian(masked, sigma=sm) if sm > 0 else masked).astype(np.float32)
                lt = threshold_local(c_img, block_size=int(win), method='gaussian')
                binary = (c_img < (lt - off)) & (mask > 0)
                binary = binary_opening(binary, footprint=footprint)
                return -float(len(regionprops(label(binary))))

            # Using 25 LHS starts and 25 BO iterations = 50 total
            res = gp_minimize(objective, space, n_calls=50, n_random_starts=25, initial_point_generator='lhs', random_state=42)
            best_off, best_win, best_sm = res.x
            
            # Final run
            if best_win % 2 == 0: best_win += 1
            c_img = (gaussian(masked, sigma=best_sm) if best_sm > 0 else masked).astype(np.float32)
            lt = threshold_local(c_img, block_size=int(best_win), method='gaussian')
            binary = (c_img < (lt - best_off)) & (mask > 0)
            binary = binary_opening(binary, footprint=footprint)
            for rp in regionprops(label(binary)):
                if min_area <= rp.area <= max_area:
                    cy, cx = rp.centroid
                    r0, c0, r1, c1 = rp.bbox
                    best_spots.append({'cx': float(cx), 'cy': float(cy), 'bbox': [int(c0), int(r0), int(c1-c0), int(r1-r0)]})
            best_params = {'sensitivity': round(50 - best_off * 500, 1), 'window': int(best_win), 'smoothing': round(float(best_sm), 1)}

        elif model_type == 'waterfall':
            from skopt import gp_minimize
            from skopt.space import Real, Integer
            from skimage.filters import gaussian, threshold_otsu
            from skimage.morphology import disk, binary_opening
            from skimage.feature import peak_local_max
            from skimage.segmentation import watershed
            from scipy.ndimage import distance_transform_edt
            from skimage.measure import label, regionprops
            
            # Search Space for Watershed (Waterfall)
            space = [
                Real(0.1, 6.0,   name='smoothing'),
                Integer(5, 100,  name='min_dist'),
                Real(-0.2, 0.2, name='offset')
            ]
            
            inv = 1.0 - masked
            def objective(params):
                sm, dist, off = params
                smoothed = gaussian(inv, sigma=sm)
                try:
                    thresh = threshold_otsu(smoothed) + off
                except: thresh = 0.5
                binary = (smoothed > thresh) & (mask > 0)
                if binary.sum() == 0: return 0
                
                dist_map = distance_transform_edt(binary)
                coords = peak_local_max(dist_map, min_distance=int(dist), labels=binary.astype(np.uint8))
                if len(coords) == 0: return 0
                
                markers = np.zeros(gray.shape, dtype=np.int32)
                markers[tuple(coords.T)] = np.arange(1, len(coords) + 1)
                ws = watershed(-dist_map, markers, mask=binary)
                return -float(len(regionprops(ws)))

            res = gp_minimize(objective, space, n_calls=50, n_random_starts=25, initial_point_generator='lhs', random_state=42)
            b_sm, b_dist, b_off = res.x
            
            # Final run
            smoothed = gaussian(inv, sigma=b_sm)
            try: thresh = threshold_otsu(smoothed) + b_off
            except: thresh = 0.5
            binary = (smoothed > thresh) & (mask > 0)
            dist_map = distance_transform_edt(binary)
            coords = peak_local_max(dist_map, min_distance=int(b_dist), labels=binary.astype(np.uint8))
            if len(coords) > 0:
                import cv2
                markers = np.zeros(gray.shape, dtype=np.int32)
                markers[tuple(coords.T)] = np.arange(1, len(coords) + 1)
                ws = watershed(-dist_map, markers, mask=binary)
                for rp in regionprops(ws):
                    if min_area <= rp.area <= max_area:
                        cy, cx = rp.centroid
                        r0, c0, r1, c1 = rp.bbox
                        
                        mask_idx = (ws[r0:r1, c0:c1] == rp.label).astype(np.uint8)
                        cnts, _ = cv2.findContours(mask_idx, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                        cnt_list = []
                        if len(cnts) > 0:
                            for pt in cnts[0]: cnt_list.append([int(pt[0][0]), int(pt[0][1])])
                        
                        best_spots.append({
                            'cx': float(cx), 'cy': float(cy), 
                            'bbox': [int(c0), int(r0), int(c1-c0), int(r1-r0)],
                            'contour': cnt_list
                        })
            
            best_params = {
                'sensitivity': round((b_off + 0.2) * 250, 1), # mapped to 0-100
                'smoothing': round(float(b_sm), 1),
                'separation': int(b_dist)
            }

        return jsonify({'spots': best_spots, 'params': best_params, 'count': len(best_spots)})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)})

@app.route('/health')
def health():
    return jsonify({'status': 'ok'})


@app.route('/generate_profiles', methods=['POST'])
def generate_profiles():
    try:
        import cv2
        from scipy.signal import find_peaks
        from scipy.ndimage import gaussian_filter1d
        data = request.get_json()
        img = load_gray(data['image'])
        lanes = data.get('lanes', [])
        detect_peaks_flag = data.get('peak_detection', False)
        # Prominence is 1-80, we invert it so higher slider = higher sensitivity (lower threshold)
        peak_prominence = 81.0 - float(data.get('peak_prominence', 10))
        peak_distance   = int(data.get('peak_distance', 5))
        smooth_sigma    = float(data.get('smooth_sigma', 1.5))
        int_threshold   = float(data.get('peak_threshold', 50)) / 100.0

        results = []
        for lane in lanes:
            cx, cy, lw, lh, angle = lane['cx'], lane['cy'], lane['w'], lane['h'], lane.get('angle', 0)
            M = cv2.getRotationMatrix2D((cx, cy), np.degrees(-angle), 1.0)
            straight = cv2.warpAffine(img, M, (img.shape[1], img.shape[0]))
            y1, y2 = max(0, int(cy - lh/2)), min(straight.shape[0], int(cy + lh/2))
            x1, x2 = max(0, int(cx - lw/2)), min(straight.shape[1], int(cx + lw/2))
            roi = straight[y1:y2, x1:x2]
            if roi.size == 0:
                results.append({'id': lane['id'], 'profile': [], 'peaks': []})
                continue

            roi_gray = roi

            # Density profile (1D)
            raw_signal = np.mean(roi_gray, axis=1)
            
            # Robust auto-polarity: Mean vs Median Skewness
            # Quenching: Mostly light pixels (BG) with dark tails (Spots) -> Mean < Median
            # Fluorescence: Mostly dark pixels (BG) with light tails (Spots) -> Mean > Median
            if np.mean(roi_gray) < np.median(roi_gray):
                # Quenching: spots are DARKER than the dominant background
                profile = 255.0 - raw_signal
            else:
                # Fluorescence: spots are LIGHTER than the dominant background
                profile = raw_signal
            
            # Remove minimum to anchor baseline at 0
            profile = profile - profile.min()

            # Smoothing
            if smooth_sigma > 0:
                profile = gaussian_filter1d(profile, sigma=smooth_sigma)

            peaks_out = []
            if detect_peaks_flag and len(profile) > 4:
                # Reverse: index 0 = Origin, last = Front  (O→F)
                p_rev = profile[::-1].copy()
                n = len(p_rev)

                # --- Normalise to 0-100 so prominence slider is scale-independent ---
                p_min, p_max = p_rev.min(), p_rev.max()
                p_range = p_max - p_min
                if p_range < 1e-6:
                    # Flat profile – no peaks possible
                    results.append({'id': lane['id'], 'profile': profile.tolist(), 'peaks': []})
                    continue
                p_norm = (p_rev - p_min) / p_range * 100.0

                print(f"[peaks] lane {lane['id']}  n={n}  range={p_range:.1f}  prominence={peak_prominence}  distance={peak_distance}")

                peak_indices, properties = find_peaks(
                    p_norm,
                    prominence=peak_prominence,   # % of 0-100 normalised range
                    distance=max(1, peak_distance)
                )
                print(f"[peaks] found {len(peak_indices)} peaks")

                # ── 2D Spot Refinement ──
                # For each peak detected in the 1D profile, we find the dominant 2D spot in its vertical band.
                model_type = data.get('model_type', 'adaptive') # Default to adaptive refinement
                for i, idx in enumerate(peak_indices):
                    # CALIBRATED Rf calculation (Origin Line to Front Line)
                    # The Box is 1.10x the solvent distance.
                    # Padding at each end is 0.05 / 1.10 of the total height.
                    n = len(p_rev)
                    y_fract = 1.0 - (float(idx) / (n - 1)) if n > 1 else 0.0
                    # y_fract: 0 at Front-edge of box, 1 at Origin-edge of box
                    # Origin Line is at approx 0.9545, Front Line is at approx 0.04545
                    y_origin_line = 1.05 / 1.10
                    y_front_line  = 0.05 / 1.10
                    rf = (y_origin_line - y_fract) / (y_origin_line - y_front_line)
                    rf = max(0.0, min(1.0, rf)) # Clamp to valid range
                    lb, rb = int(properties['left_bases'][i]), int(properties['right_bases'][i])
                    
                    # ── FWHM Visual Banding (v1 chromatography style) ──
                    local_peak_val = p_norm[idx]
                    local_base = min(p_norm[lb], p_norm[rb])
                    # 50% height (FWHM) is the standard for "neat" cropped analytical bands
                    # 50% height (FWHM) is the standard for "neat" cropped analytical bands
                    threshold_val = local_base + (local_peak_val - local_base) * int_threshold
                    
                    v_lb, v_rb = lb, rb
                    for j in range(idx, lb, -1):
                        if p_norm[j] < threshold_val:
                            v_lb = j; break
                    for j in range(idx, rb):
                        if p_norm[j] < threshold_val:
                            v_rb = j; break
                    
                    # Ensure it doesn't shrink too much for very narrow peaks
                    if (v_rb - v_lb) < 2:
                        v_lb, v_rb = max(0, idx-2), min(n-1, idx+2)

                    # Keep AUC area calculation on the wider bases for better accuracy, 
                    # but visualize the "cropped" band
                    base_val = min(p_norm[lb], p_norm[rb])
                    area = float(np.trapz(np.clip(p_norm[lb:rb+1] - base_val, 0, None)))

                    peaks_out.append({
                        'idx':    int(idx),
                        'rf':     round(rf, 3),
                        'height': round(float(p_rev[idx]), 2),
                        'area':   round(area, 2),
                        'lb':     int(v_lb), 'rb': int(v_rb)
                    })

            results.append({
                'id':     lane['id'],
                'profile': profile.tolist(),
                'peaks':   peaks_out
            })

        return jsonify({'results': results})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)})

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 7860))
    print("=" * 60, flush=True)
    print("  TLC Detection Server", flush=True)
    print(f"  Open browser at:  http://localhost:{port}", flush=True)
    print("=" * 60, flush=True)
    app.run(host='0.0.0.0', port=port, debug=False)

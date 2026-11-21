/**
 * RndB Measure - radix-2 FFT
 *
 * Small, dependency-free, and fast enough to deconvolve a 5 s sweep in the
 * browser. Operates in place on separate real/imaginary Float64Arrays, which
 * is the layout the rest of the analysis chain uses.
 *
 * Float64, not Float32: deconvolution divides one spectrum by another, and the
 * quiet ends of a 20 Hz - 20 kHz sweep are where the division is most
 * ill-conditioned. Single precision throws away headroom exactly where the
 * measurement is already weakest.
 */
class FFT {
    /** @param {number} n transform length; must be a power of two. */
    constructor(n) {
        if (n < 2 || (n & (n - 1)) !== 0) {
            throw new Error(`FFT length must be a power of two, got ${n}`);
        }
        this.n = n;

        // Bit-reversal permutation, precomputed once per length.
        this.rev = new Uint32Array(n);
        const bits = Math.log2(n);
        for (let i = 0; i < n; i++) {
            let r = 0;
            for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
            this.rev[i] = r;
        }

        // Twiddles for the full circle: exp(-2*pi*i*k/n), k < n/2. Each stage
        // strides through this table rather than recomputing sin/cos.
        this.cos = new Float64Array(n / 2);
        this.sin = new Float64Array(n / 2);
        for (let k = 0; k < n / 2; k++) {
            this.cos[k] = Math.cos((-2 * Math.PI * k) / n);
            this.sin[k] = Math.sin((-2 * Math.PI * k) / n);
        }
    }

    /** In-place forward transform. */
    forward(re, im) {
        const n = this.n, rev = this.rev, cosT = this.cos, sinT = this.sin;

        for (let i = 0; i < n; i++) {
            const j = rev[i];
            if (j > i) {
                let t = re[i]; re[i] = re[j]; re[j] = t;
                t = im[i]; im[i] = im[j]; im[j] = t;
            }
        }

        for (let len = 2; len <= n; len <<= 1) {
            const half = len >> 1;
            const stride = n / len;
            for (let i = 0; i < n; i += len) {
                for (let j = 0, k = 0; j < half; j++, k += stride) {
                    const wr = cosT[k], wi = sinT[k];
                    const a = i + j, b = a + half;
                    const xr = re[b] * wr - im[b] * wi;
                    const xi = re[b] * wi + im[b] * wr;
                    re[b] = re[a] - xr; im[b] = im[a] - xi;
                    re[a] += xr;        im[a] += xi;
                }
            }
        }
    }

    /**
     * In-place inverse transform, scaled by 1/n.
     * Uses the conjugate identity so only one butterfly implementation exists
     * and the two directions cannot drift apart.
     */
    inverse(re, im) {
        const n = this.n;
        for (let i = 0; i < n; i++) im[i] = -im[i];
        this.forward(re, im);
        const s = 1 / n;
        for (let i = 0; i < n; i++) { re[i] *= s; im[i] = -im[i] * s; }
    }

    /** Smallest power of two >= n. */
    static nextPow2(n) {
        let p = 1;
        while (p < n) p <<= 1;
        return p;
    }

    /** Zero-padded copy of `src` as a Float64Array of length n. */
    static pad(src, n) {
        const out = new Float64Array(n);
        out.set(src.subarray ? src.subarray(0, Math.min(src.length, n))
                             : src.slice(0, Math.min(src.length, n)));
        return out;
    }
}

if (typeof module !== 'undefined' && module.exports) module.exports = FFT;

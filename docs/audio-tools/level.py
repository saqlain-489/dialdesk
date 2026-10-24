# Usage: level.py file.wav  ->  RMS percentiles (50 ms windows), peak and clipped samples, in dBFS.
import sys, wave, array, math
w = wave.open(sys.argv[1]); n = w.getnchannels(); sr = w.getframerate()
x = array.array('h', w.readframes(w.getnframes()))[0::n]
db = lambda v: 20*math.log10(max(v, 1e-9)/32768)
win = int(sr*0.05); rms = sorted(math.sqrt(sum(s*s for s in x[i:i+win])/win) for i in range(0, len(x)-win, win))
pct = lambda p: rms[min(len(rms)-1, int(p*len(rms)))]
clip = sum(1 for s in x if abs(s) >= 32000)
print(f"{len(x)/sr:4.1f}s  peak {db(max(abs(s) for s in x)):6.1f} dBFS  rms p10 {db(pct(.1)):6.1f}  p50 {db(pct(.5)):6.1f}  p90 {db(pct(.9)):6.1f}  clipped {clip} samples")

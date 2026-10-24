#!/usr/bin/env bash
# 4 s of silence from the default mic: mains hum vs phone-band noise. Run with the charger in, then out.
HERE=$(dirname "$0"); T=$(mktemp -d)
echo "Charger connected: $(cat /sys/class/power_supply/AC/online 2>/dev/null) (1 = yes) | mic $(wpctl get-volume @DEFAULT_AUDIO_SOURCE@)"
echo "Stay silent 4 s..."; timeout 4 pw-record --rate 48000 --channels 1 --format s16 "$T/hum.wav" 2>/dev/null
lvl() { ffmpeg -v error -y -i "$T/hum.wav" -af "$1" "$T/b.wav"; python3 "$HERE/level.py" "$T/b.wav" | sed -E 's/.*p50 +([-0-9.]+).*/\1 dBFS/'; }
echo "50 Hz hum:          $(lvl 'bandpass=f=50:width_type=h:w=6')"
echo "phone-band noise:   $(lvl 'highpass=f=300,lowpass=f=3400')"
rm -rf "$T"

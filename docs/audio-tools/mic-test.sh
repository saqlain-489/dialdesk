#!/usr/bin/env bash
# Raw headset mic (before Chrome): 4 s silence, the opener at normal pace, then slow. Prints broadband and phone-band levels.
HERE=$(dirname "$0"); T=${1:-$(mktemp -d)}
TEXT="Hi, is this Dana? Dana, this is Sam from Acme Co. I'm calling about your website."
rec() { timeout "$2" pw-record --rate 48000 --channels 1 --format s16 "$T/$1.wav" 2>/dev/null; }
echo "Mic: $(wpctl inspect @DEFAULT_AUDIO_SOURCE@ | grep -m1 node.description | cut -d'"' -f2), $(wpctl get-volume @DEFAULT_AUDIO_SOURCE@)"
echo "1/3  Stay SILENT 4 s (headset where it sits on a call)..."; sleep 1; rec noise 4
echo "2/3  Read at NORMAL call pace (12 s):  $TEXT"; sleep 2; echo "     >>> GO"; rec normal 12
echo "3/3  Read it SLOWLY, ~70% speed (16 s)"; sleep 2; echo "     >>> GO"; rec slow 16
for f in noise normal slow; do
  ffmpeg -v error -y -i "$T/$f.wav" -af "highpass=f=300,lowpass=f=3400" "$T/${f}_band.wav"
  printf "%-7s broadband  " $f; python3 "$HERE/level.py" "$T/$f.wav"
  printf "%-7s phone band " $f; python3 "$HERE/level.py" "$T/${f}_band.wav"
done
echo "Recordings kept in $T"

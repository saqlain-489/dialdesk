#!/usr/bin/env bash
# Logs every change of the OS mic volume (no audio) until Ctrl-C. Run during a shift: with auto-gain off it should never move.
prev=""; while true; do v="$(wpctl get-volume @DEFAULT_AUDIO_SOURCE@ 2>&1)"; [ "$v" != "$prev" ] && echo "$(date +%T) $v" && prev="$v"; sleep 0.25; done

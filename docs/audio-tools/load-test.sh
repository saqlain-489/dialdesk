#!/usr/bin/env bash
# Latency to the router (50 pps, a call's packet rate) and to Twilio Ashburn: idle, then while saturating download, then upload.
GW=$(ip route | awk '/^default/{print $3; exit}'); EDGE=voice-js.ashburn.twilio.com; T=$(mktemp -d)
pings() { local name=$1
  ( ping -i 0.02 -c 750 -q "$GW" 2>&1 | tail -2 | tr '\n' ' ' | sed "s/^/[$name] router 50pps: /"; echo ) &
  ( ping -i 0.2 -c 75 -q $EDGE 2>&1 | tail -2 | tr '\n' ' ' | sed "s/^/[$name] ashburn 5pps: /"; echo ) & }
echo "Router $GW via $(ip route | awk '/^default/{print $5; exit}')"
pings idle; sleep 16; wait
pings download
for i in 1 2 3 4; do curl -s -o /dev/null --max-time 15 -w "[download] stream$i %{speed_download} B/s\n" 'https://speed.cloudflare.com/__down?bytes=50000000' & done; wait
head -c 60000000 /dev/zero > "$T/up.bin"
pings upload
for i in 1 2; do curl -s -o /dev/null --max-time 15 -w "[upload] stream$i %{speed_upload} B/s\n" -X POST --data-binary @"$T/up.bin" https://speed.cloudflare.com/__up & done; wait
rm -rf "$T"

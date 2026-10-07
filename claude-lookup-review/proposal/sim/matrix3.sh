#!/bin/sh
# Post-review matrix: fixed Pages code (working tree) + worker-v2. 5 scenarios at a time to limit CPU skew.
cd "$(dirname "$0")/../.."
mkdir -p proposal/results
run() { name=$1; shift; timeout 500 node --no-warnings proposal/sim/run.mjs --do=v2 --pages=v2 "$@" > "proposal/results/v3_$name.json" 2>"proposal/results/v3_$name.err"; }
{
run read_burst_250x3           --n=100 --gap=250 --conc=3
run read_burst_100x4           --n=100 --gap=100 --conc=4
run read_spread30_250x3        --n=100 --gap=250 --conc=3 --arrival=30000
run read_spread30_100x4        --n=100 --gap=100 --conc=4 --arrival=30000
run live_burst_250x3           --n=100 --gap=250 --conc=3 --live=1
run live_burst_100x4           --n=100 --gap=100 --conc=4 --live=1
run live_spread30_100x4        --n=100 --gap=100 --conc=4 --live=1 --arrival=30000
run live_083ps_100x4           --n=60  --gap=100 --conc=4 --live=1 --arrival=72000
run live_083ps_250x3           --n=60  --gap=250 --conc=3 --live=1 --arrival=72000
run real_read_burst_100x4      --n=100 --gap=100 --conc=4 --bg=60000 --cfg=3 --cahist=60 --percond=3
run real_live_spread30_100x4   --n=100 --gap=100 --conc=4 --live=1 --arrival=30000 --bg=60000 --cfg=3 --cahist=60 --percond=3
run http200_quota6_burst       --n=100 --gap=100 --conc=4 --quota=6 --limitstatus=200
run slow800_burst_100x4        --n=100 --gap=100 --conc=4 --median=800
} 
echo finished > proposal/results/_done3

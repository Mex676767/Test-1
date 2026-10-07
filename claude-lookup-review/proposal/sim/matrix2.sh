#!/bin/sh
cd "$(dirname "$0")/../.."
run() { name=$1; shift; timeout 600 node --no-warnings proposal/sim/run.mjs "$@" > "proposal/results/$name.json" 2>"proposal/results/$name.err"; }
run cur_orig_n100_burst        --do=v1 --pages=orig  --n=100 &
run cur_orig_n100_spread30s    --do=v1 --pages=orig  --n=100 --arrival=30000 &
run cur_nocap_n100_spread30s   --do=v1 --pages=nocap --n=100 --arrival=30000 &
run v2_n100_burst_gap250       --do=v2 --pages=v2    --n=100 --gap=250 --conc=3 &
run v2_n100_burst_quota6       --do=v2 --pages=v2    --n=100 --quota=6 &
run v2_n100_burst_slow800      --do=v2 --pages=v2    --n=100 --median=800 &
wait
echo finished > proposal/results/_done2

#!/bin/sh
# Runs the scenario matrix in parallel; one JSON line per scenario in proposal/results/.
cd "$(dirname "$0")/../.."
run() { name=$1; shift; timeout 400 node --no-warnings proposal/sim/run.mjs "$@" > "proposal/results/$name.json" 2>"proposal/results/$name.err"; }
run cur_orig_n25_burst   --do=v1 --pages=orig  --n=25  &
run cur_orig_n100_burst  --do=v1 --pages=orig  --n=100 &
run cur_nocap_n100_burst --do=v1 --pages=nocap --n=100 &
run cur_nocap_n100_live  --do=v1 --pages=nocap --n=100 --live=1 &
run v2_n100_burst        --do=v2 --pages=v2    --n=100 &
run v2_n100_live         --do=v2 --pages=v2    --n=100 --live=1 &
run v2_n100_spread5s     --do=v2 --pages=v2    --n=100 --arrival=5000 &
run v2_n100_spread30s    --do=v2 --pages=v2    --n=100 --arrival=30000 &
wait

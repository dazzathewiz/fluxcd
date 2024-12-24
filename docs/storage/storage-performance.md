`kubectl apply -f https://raw.githubusercontent.com/yasker/kbench/main/deploy/fio.yaml`

`kubectl logs -l kbench=fio -f`

`kubectl delete -f https://raw.githubusercontent.com/yasker/kbench/main/deploy/fio.yaml`

https://github.com/yasker/kbench


Example result, Longhorn nodes w/ 3x 1TB Samsung EVO 970 NVME (1 per node)
```
TEST_FILE: /volume/test
TEST_OUTPUT_PREFIX: test_device
TEST_SIZE: 30G
Benchmarking iops.fio into test_device-iops.json
Benchmarking bandwidth.fio into test_device-bandwidth.json
Benchmarking latency.fio into test_device-latency.json

=========================
FIO Benchmark Summary
For: test_device
CPU Idleness Profiling: disabled
Size: 30G
Quick Mode: disabled
=========================
IOPS (Read/Write)
        Random:            9,380 / 5,288
    Sequential:          14,895 / 10,262

Bandwidth in KiB/sec (Read/Write)
        Random:        300,118 / 160,951
    Sequential:        318,654 / 198,911
                                        

Latency in ns (Read/Write)
        Random:      902,039 / 1,093,148
    Sequential:      926,903 / 1,043,971
```
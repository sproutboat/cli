# Direct app comparison: Sproutboat v0.60.0

Run: 2026-11-23T00:49:57Z. Same validated Worker-style fixture on one Linux host, 3 randomized rounds, 50 offered requests/s. This fixed-rate run does not measure maximum throughput or hosted Cloudflare Workers.

| Measure | Node | workerd | Sproutboat |
| --- | ---: | ---: | ---: |
| Correct probes per round | 23/23 | 23/23 | 23/23 |
| App artifact | 4997 bytes | 3943 bytes | 6945744 bytes |
| Runtime executable | 148011296 bytes | 134218000 bytes | included in app artifact |
| Initialized idle PSS | 49.87 MiB | 46.42 MiB | 7.03 MiB |
| Exec to first correct response | 93.9 ms | 20.84 ms | 4.36 ms |
| Order p95 at fixed load | 1.58 ms | 0.88 ms | 0.63 ms |
| Mixed p95 at fixed load | 52.15 ms | 51.73 ms | 51.92 ms |
| Order CPU per 1,000 correct responses | 995.96 ms | 593.5 ms | 261.52 ms |
| Correct measured responses | 3000 | 3000 | 3000 |

App artifact sizes count the Node source plus shared logic, the workerd bundle, and the Sproutboat standalone binary. Node and workerd also require their separately listed runtime executables and possibly shared system libraries. These sizes are an inventory, not equivalent compressed deployment packages.

Idle PSS is the median of one sample per second after correctness checks. Startup includes the test gate and one verified HTTP response. The order workload sends valid roughly 1 KiB JSON; mixed traffic sends 90% orders and 10% requests to a local upstream delayed by 50 ms. Every measured response is checked. The generator and upstream share this host on another CPU, and other services remain running.

This is a direct-app fixed-rate comparison. It does not establish saturation, many-app density, public-platform overhead, or a universal latency ranking. Raw samples, cgroup accounting, source hashes, executable hashes, versions and machine details are in the JSON artifact.

Raw results SHA-256: `ed2a753912f268c5f69144e5b4da1c960203e77772e3751ca869fdc60869b71e`.

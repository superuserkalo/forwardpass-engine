# Dependency audit notes

Checked on 27 October 2026 with `npm audit` after a clean `npm ci`.

The public snapshot updates the MCP client and server to 2.4.0, Zod to 4.6.7, Undici to 7.30.1 and Wrangler to 4.154.0. Compatible transitive updates are included in the lockfile. These updates reduced the audit result from 20 affected package entries to 10. There are no remaining moderate or critical entries; npm rates the remaining 10 entries high.

The remaining entries are in two dependency chains:

| Integration | Advisory-bearing dependencies | References |
| --- | --- | --- |
| Experimental Teams adapter | `@azure/msal-node` through `@microsoft/teams.apps` and `@chat-adapter/teams` | [MSAL advisory](https://github.com/advisories/GHSA-xcx6-jx8p-x3h5) |
| Cloudflare browser tooling | `basic-ftp` and `extract-zip` through the Puppeteer browser and proxy packages | [FTP parser advisory](https://github.com/advisories/GHSA-c475-qrg2-pj4r), [archive symlink advisories](https://github.com/advisories/GHSA-jmr9-qjv8-65gv), [additional archive advisory](https://github.com/advisories/GHSA-7pqw-9j4j-h8q3) |

The package count includes parent packages affected by the same underlying advisories. It is not a count of confirmed vulnerabilities in the engine's request handlers. This release does not establish reachability or exploitability for these dependencies.

The reported automatic fixes require breaking dependency changes or downgrades. Those changes were not applied to this snapshot. Teams needs operator credentials before use; the public template contains none. The browser integration remains included.

Run `npm audit` against the lockfile before deploying. Resolve or assess these remaining advisories for your deployment rather than treating the passing test suite as a security assessment.

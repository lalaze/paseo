# Personal quota bundle

The Kimi renewal payload comes from
[`lalaze/paseo-plugins`, commit `34f097f42627b5794d78675c05cc03820fd37f82`](https://github.com/lalaze/paseo-plugins/tree/34f097f42627b5794d78675c05cc03820fd37f82/agy-quota/src).
It retains Kimi-owned credential renewal, formatted with this repository's formatter.
Paseo 0.11.1 moved quotas to built-in Usage sources. The personal runtime omits the Copilot
Usage source without changing GitHub credentials and renews Kimi's file-backed login before
its source fetches usage. Other official built-ins remain enabled.
Do not restore the retired Antigravity Hub or quota reader; those are archived in `paseo-plugins`.
Environment API keys remain read-only. The baseline pins the reviewed built-in registry, Kimi reader, Usage
registry and SDK, wire schemas, and node-pty version.
The payload directory is excluded from application lint rules so deployment integration does
not refactor the separately maintained readers. The installer and deployment tests stay linted.

Keep this snapshot in the deployment source so macOS and Linux receive identical patches.
Update the payloads and compatibility baseline together after reviewing upstream changes.
Never update hashes merely to make an incompatible build pass. The installer modifies only
the unpublished release copy. Recovery uses the previous release rather than mutating a
running installation or keeping backups in an external plugin directory.

See [personal deployment](../../docs/release.md#personal-source-deployment) for preparation,
activation, and rollback. No separate patch installation command is needed.

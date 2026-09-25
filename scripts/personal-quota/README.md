# Personal quota bundle

The three provider payloads come from
[`lalaze/paseo-plugins`, commit `34f097f42627b5794d78675c05cc03820fd37f82`](https://github.com/lalaze/paseo-plugins/tree/34f097f42627b5794d78675c05cc03820fd37f82/agy-quota/src).
They retain the existing Antigravity reader and Kimi-owned credential renewal, formatted with
this repository's formatter. The compatibility baseline comes from the same patch version;
its quota boundaries also match Paseo 0.9.2.
The payload directory is excluded from application lint rules so deployment integration does
not refactor the separately maintained readers. The installer and deployment tests stay linted.

Keep this snapshot in the deployment source so macOS and Linux receive identical patches.
Update the payloads and compatibility baseline together after reviewing upstream changes.
Never update hashes merely to make an incompatible build pass. The installer modifies only
the unpublished release copy. Recovery uses the previous release rather than mutating a
running installation or keeping backups in an external plugin directory.

See [personal deployment](../../docs/release.md#personal-source-deployment) for preparation,
activation, and rollback. No separate patch installation command is needed.

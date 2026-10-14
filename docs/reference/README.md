# docs/reference

Generated reference material for the marketplace publish feature (plan PB.0).

The files `cults3d-schema.json` (full GraphQL `__schema`) and `cults3d-findings.md`
(human-readable findings) do not exist yet. The owner generates them once:

    set CULTS_USER and CULTS_API_KEY in your own shell, then
    node scripts/cults-introspect.mjs

The script reads the credentials from the environment only and never writes them.
Review the diff, then commit both files.

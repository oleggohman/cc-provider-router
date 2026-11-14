# Provider Router for Claude Code

A Claude Code mod that routes each model request by its model id's prefix, so one
session can use several providers: unprefixed models stay on your Claude
subscription, while `anthropic:<model>`, `openai:<model>`, `zai:<model>` and
`custom:<name>:<model>` go to other providers.

> Work in progress. Full documentation (setup, configuration, limits) comes with the first release.

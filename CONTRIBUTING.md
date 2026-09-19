# Contributing

Thanks for helping. This is a small project for churches, so simple and dependable beats clever.

- Read [`CLAUDE.md`](CLAUDE.md) (commands, conventions) and [`SPEC.md`](SPEC.md) (what we're building and why).
- Run `npm run lint && npm run typecheck && npm test` and `npm run worker:lint && npm run worker:test` before
  opening a pull request. CI runs the same checks and also builds the Docker images.
- Add tests with the change. Permission checks, file naming, scripture reading and the job state machine are
  the parts most worth testing.
- Keep the UI plain and readable for people who aren't technical. Touch targets are at least 44 px.
- Never commit secrets, real sermon audio or anything from `fixtures/private/`.
- Anything that changes what is sent to a third party must be listed in the README's "Where sermon content
  goes" section in the same change.

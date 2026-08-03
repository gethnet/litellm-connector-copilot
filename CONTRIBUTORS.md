# Contributors ✨

<!-- ALL-CONTRIBUTORS-BADGE:START - Do not remove or modify this section -->
[![All Contributors](https://img.shields.io/badge/all_contributors-1-orange.svg?style=flat-square)](#-contributors)
<!-- ALL-CONTRIBUTORS-BADGE:END -->

Thanks goes to these wonderful people ([emoji key](https://allcontributors.org/docs/en/emoji-key)):

<!-- ALL-CONTRIBUTORS-LIST:START - Do not remove or modify this section -->
<!-- prettier-ignore-start -->
<!-- markdownlint-disable -->
<table>
  <tbody>
    <tr>
      <td align="center" valign="top" width="16.66%"><a href="https://github.com/amwdrizz"><img src="https://avatars.githubusercontent.com/u/amwdrizz?v=4?s=100" width="100px;" alt="amwdrizz"/><br /><sub><b>amwdrizz</b></sub></a><br /><a href="https://github.com/gethnet/litellm-connector-copilot/commits?author=amwdrizz" title="Code">💻</a> <a href="#ideas-amwdrizz" title="Ideas, Planning, & Feedback">🤔</a> <a href="https://github.com/gethnet/litellm-connector-copilot/commits?author=amwdrizz" title="Documentation">📖</a> <a href="#infra-amwdrizz" title="Infrastructure (Hosting, Build-Tools, etc)">🚇</a> <a href="#maintenance-amwdrizz" title="Maintenance">🚧</a></td>
    </tr>
  </tbody>
</table>

<!-- markdownlint-restore -->
<!-- prettier-ignore-end -->

<!-- ALL-CONTRIBUTORS-LIST:END -->

## Contributing

We use the [all-contributors](https://allcontributors.org) specification to recognize everyone who contributes to this project.

### How to Add a Contributor

You can add contributors in multiple ways:

**1. Via the All Contributors GitHub App (on a PR or issue):**
```
@all-contributors add @username for code,docs,ideas
```

The repository maintainer must install the official [All Contributors GitHub App](https://github.com/apps/allcontributors) before this command is available. The app creates a visible commit that updates this file and `.all-contributorsrc`.

**2. Manual (via command):**
```bash
npx all-contributors add <username> <contribution-type>
```

**Contribution types include:**
- `code` — Code contributions
- `docs` — Documentation
- `ideas` — Ideas & planning
- `bug` — Bug reports
- `test` — Tests
- `review` — Code review
- `infra` — Infrastructure
- `maintenance` — Maintenance

### For Contributors

Want to contribute? We'd love your help! Here's how:

1. **Pick an issue** — Look for issues labeled `good first issue` or `help wanted`
2. **Fork and branch** — Create a feature branch from `main`
3. **Code and test** — Follow the coding standards in `AGENTS.md` and ensure tests pass
4. **Open a PR** — Submit a pull request with a clear description
5. **Get reviewed** — We'll review and provide feedback
6. **Contributors recognized** — A maintainer adds the GitHub account that should receive credit after review.

### Attribution policy

Contributors are recognized by **GitHub account**, not by the tool used to prepare a contribution. Work prepared with Copilot or another AI agent while acting through a contributor's GitHub account is attributed to that account; AI agents are never added as separate contributors. Automated accounts and bots are not added unless a maintainer explicitly chooses to do so.

### Development Setup

```bash
npm install              # Install dependencies
npm run compile          # Check TypeScript
npm run lint:fix         # Format and lint
npm run test:coverage    # Run tests with coverage
```

See [AGENTS.md](../AGENTS.md) for detailed engineering standards and [README.md](../README.md) for project overview.

---

See [CONTRIBUTING.md](.github/CONTRIBUTING.md) for contribution guidelines and stale PR policy.
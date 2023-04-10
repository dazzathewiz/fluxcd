# Infrastructure Configs

## 1Password provider using External Secrets Operator
See: [1Password Connect](../doc-1password)

## Notify and Alerts `notify-slack.yaml`
- A slack URL is configured in 1Password `fluxcd-slackurl`
- The URL secret `fluxcd-slackurl` syncronised from 1Password
- A `slack` provider type is configured
- `on-call-webapp` Alert is configured with default settings

### Sources
[Flux Guide][https://fluxcd.io/flux/guides/notifications/]
[TechnoTim Guide][https://docs.technotim.live/posts/flux-devops-gitops/]

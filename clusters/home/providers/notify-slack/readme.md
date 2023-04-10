# flux-system

Configurations away from the default.

## Notify
- A slack URL is configured in 1Password `fluxcd-slackurl`
- `secret-slackurl.yml` syncronises 1Password with kubernetes secret `fluxcd-slackurl`
- `slack-provider.yml` is the setup of the Slack Provider type
- `slack-alert.yml` is the default alert configuration
- `kustomization.yaml` is updated with the .yml files to ensure flux loads the configuration

### Sources
[Flux Guide][https://fluxcd.io/flux/guides/notifications/]
[TechnoTim Guide][https://docs.technotim.live/posts/flux-devops-gitops/]

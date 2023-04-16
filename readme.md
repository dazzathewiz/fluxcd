# Fluxcd setup

The dazzathewiz kubernetes cluster using [fluxcd.io][fluxcd]

📺 [Watch the TechnoTim Video](https://www.youtube.com/watch?v=PFLimPh5-wo)

## Setup

Install flux on a machine you control kubernetes with. EG: OSX
```brew install fluxcd/tap/flux```

Bootstrap flux in the kubernetes cluster to your repo:
```
flux bootstrap github \
  --components-extra=image-reflector-controller,image-automation-controller \
  --owner=dazzathewiz \
  --repository=fluxcd \
  --branch=main \
  --path=clusters/home \
  --personal \
  --token-auth
  ```

## Tasks

[Updating Flux](https://docs.technotim.live/posts/update-flux/)

Apply new repo updates immediately: `flux reconcile kustomization flux-system --with-source`

## Features

### Infrastructure Configuration

- ✅ [Flux Notify/Alerts in Slack](infrastructure/configs#notify-and-alerts-notify-slackyaml)
- ✅ [1Password integration using External Secrets Operator](infrastructure/doc-1password)
- ✅ [Traefik/Cert-Manager Ingress](infrastructure/configs#traefik--cert-manager)
- ✅ [Rancher](infrastructure/configs#rancher)
- ✅ [Longhorn](infrastructure/configs#longhorn)

## Repo Structure

Loosely following the [Monorepo][flux-monorepo] structure, but specifically referring to the example:
 [flux2-kustomise-helm-example][flux2-kustomise-helm-example]

[fluxcd]: https://fluxcd.io/
[flux2-kustomise-helm-example]: https://github.com/fluxcd/flux2-kustomize-helm-example
[flux-monorepo]: https://fluxcd.io/flux/guides/repository-structure/#monorepo

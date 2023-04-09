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

✅ [Flux Notify/Alerts in Slack](clusters/home/flux-system#notify)
✅ [1Password integration using External Secrets Operator](clusters/home/1password)

[fluxcd]: https://fluxcd.io/

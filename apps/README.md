# Applications

## Quick Reference
### [Cluster DNS for Services and Pods](https://kubernetes.io/docs/concepts/services-networking/dns-pod-service/)
When building a stack of pods connecting to each other, to get the correct service name:
- DNS Name is made up of <Service.Name>.<Namespace>
- Lookup the Service Name under "Services" in Lens or `kubectl get svc --all-namespaces`
- If you want a specific CNAME to reference a service in cluster pods, use `ExternalName` Service type; See: [publishing-services-service-types](https://kubernetes.io/docs/concepts/services-networking/service/#publishing-services-service-types)

### App Services
Note: External references are manage by DNS outside of the Kubernetes cluster (EG PiHole)

|  App Name  |  Internal Ref  |  External Ref  |
| ---------- | -------------- | -------------- |
| influx-v1 | influx-v1-influxdb.databases | influxdbv1.inf.${PERSONAL_DOMAIN} |
| influx-v2 | influx-v2-influxdb2.databases | influxdb.inf.${PERSONAL_DOMAIN} |
| mosquitto | mosquitto.home-automation | mqtt.home.${PERSONAL_DOMAIN} |
| portainer | portainer.infrastructure | portainer.inf.${PERSONAL_DOMAIN} |
| ubiquiti-uisp | ubiquiti-uisp.infrastructure | unms.${PERSONAL_DOMAIN} |
| unifi-controller | unifi-controller.infrastructure | _external proxy_ |
| grafana | grafana.monitoring | _external proxy_ |
| organizr | organizr.web | _external proxy_ |

### App Pod Recreate
Some pods need an [update strategy](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/#strategy) set to "Recreate". By default, 
Kubernetes applies the "RollingUpdate" strategy which, when a change is desired (or made in Flux), creates a new pod and waits for success before 
removing the old pod. This is problematic in deployments where only 1 pod at any time is preferred, EG: when a PVC is set to `readWriteOnce` it can 
only be attached to 1 pod so the new pod deployment will fail until old pod is manually deleted.

#### Change Update Strategy to "Recreate"
```
spec:
    strategy: Recreate
```

#### Issue changing from existing "RollingUpdate" to "Recreate" Strategy
You may experience invalid: spec.strategy.rollingUpdate: Forbidden: may not be specified when strategy `type` is 'Recreate'
- Manually patch the deployment because overwriting existing config [doesn't work in Flux](https://github.com/gimlet-io/onechart/issues/35)

Follow these instructions to manually [patch the Deployment using retainKeys](https://kubernetes.io/docs/tasks/manage-kubernetes-objects/update-api-object-kubectl-patch/#use-strategic-merge-patch-to-update-a-deployment-using-the-retainkeys-strategy)

### App Persistent Volumes
Apps having persistent data that is important not to be lost/deleted, I recommend using the [retain](https://kubernetes.io/docs/concepts/storage/persistent-volumes/#retain) policy. This is to prevent a sitation where accidentally removing the Flux reference and a reconcilliation then deleting all references to the app, including deleting the PersistentVolume.

```
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: pv_claim
  namespace: ns_one
spec:
  storageClassName: longhorn
  persistentVolumeReclaimPolicy: Retain
```

\# Note that if you forget when initally setting up the app, Flux may not patch the existing PVC after changing the PVC spec. In this case, you should [Patch/Change the reclaim policy of PersistentVolume](https://kubernetes.io/docs/tasks/administer-cluster/change-pv-reclaim-policy/#changing-the-reclaim-policy-of-a-persistentvolume) manually:
`kubectl patch pv <your-pv-name> -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'`

## Plex

- Resource scheduleing the GPU

    ### GPU Resource passthrough

    Find the GPU resources available on worker nodes by:
    - Running `lspci -nn` or `lspci -vmm` and look for `VGA compatible controller` in the output
    - Correlating the PCI ID's to [online ID list](https://pci-ids.ucw.cz/v2.2/pci.ids)

    ### GPU Preferred Scheduling
    Desired state is that when the plex container is scheduled, it picks the node with the best GPU available. To achieve this, we need to understand 
    PCI device `class`, `vendor`, and `device`. The node-feature-discovery in the cluster is configured to include this in a node label:
    | Node Label | Class | Vendor | Device |
    | --- | --- | --- | --- |
    | `feature.node.kubernetes.io/pci-0300_8086_4c8a.present=true` | `0300` -> "VGA compatible controller" | `8086` -> "Intel Corporation" | `3e92` -> "RocketLake-S GT1 [UHD Graphics 750]" |
    | `feature.node.kubernetes.io/pci-0300_8086_3e92.present=true` | `0300` -> "VGA compatible controller" | `8086` -> "Intel Corporation" | `3e92` -> "UHD Graphics 630 (Desktop)" |
    | `feature.node.kubernetes.io/pci-0300_8086_1912.present=true` | `0300` -> "VGA compatible controller" | `8086` -> "Intel Corporation" | `1912` -> "HD Graphics 530" |

    ### Other Reading
    [Clusters containing different types of GPU's](https://kubernetes.io/docs/tasks/manage-gpus/scheduling-gpus/)
See this [home-ops](https://github.com/dcplaya/home-ops/blob/main/k8s/clusters/cluster-1/manifests/rook-ceph-external/cluster/README.md) repo for further background


## Requirements

These are automatically setup in the environment by ansible [dazzathewiz/infrastructure](https://github.com/dazzathewiz/infrastructure):
* Make sure prometheus endpoint is enabled in proxmox via `ceph mgr module enable prometheus`
* Any RBD and CephFS pools are already setup in the external Ceph cluster, for example: `Ceph_k3s_data` (RBD) and `cephfs_plexdata_data` (EC Pool), `cephfs_plexdata_metadata` (meta-data pool), configured with cephfs name `cephfs_plexdata`
* The Rook Ceph Operator needs to be installed in the cluster

## Get configuration

1. To get the secrets, run on external ceph cluster server (proxmox)
    ```
    python3 create-external-cluster-resources.py \
    --rbd-data-pool-name Ceph_k3s_data \
    --namespace rook-ceph-external \
    --format bash
    ```

    Note you can be more fullsome in specifing options within the script, however it detect these options in the output export anyway:
    ```
    python3 create-external-cluster-resources.py \
    --cephfs-filesystem-name cephfs_plexdata --cephfs-data-pool-name ceph_plexdata_data --cephfs-metadata-pool-name cephfs_plexdata_metadata \
    --rbd-data-pool-name Ceph_k3s_data \
    --cluster-name ceph-pve-external \
    --monitoring-endpoint <nodeIP>,<nodeIP>,<nodeIP> --monitoring-endpoint-port 9283 \
    --namespace rook-ceph-external \
    --format bash
    ```

    This will result in something like:
    ```
    export NAMESPACE=rook-ceph-external
    export ROOK_EXTERNAL_FSID=xxx-xxxx-xxx-xxxx
    export ROOK_EXTERNAL_USERNAME=client.healthchecker
    export ROOK_EXTERNAL_CEPH_MON_DATA=<node_name>=<ip>:6789
    export ROOK_EXTERNAL_USER_SECRET=<secret>
    export ROOK_EXTERNAL_DASHBOARD_LINK=https://<ip>:8443/
    export CSI_RBD_NODE_SECRET=<secret>
    export CSI_RBD_NODE_SECRET_NAME=csi-rbd-node
    export CSI_RBD_PROVISIONER_SECRET=<secret>
    export CSI_RBD_PROVISIONER_SECRET_NAME=csi-rbd-provisioner
    export CEPHFS_POOL_NAME=ceph_plexdata_data
    export CEPHFS_METADATA_POOL_NAME=cephfs_plexdata_metadata
    export CEPHFS_FS_NAME=cephfs_plexdata
    export CSI_CEPHFS_NODE_SECRET=<secret>
    export CSI_CEPHFS_PROVISIONER_SECRET=<secret>
    export CSI_CEPHFS_NODE_SECRET_NAME=csi-cephfs-node
    export CSI_CEPHFS_PROVISIONER_SECRET_NAME=csi-cephfs-provisioner
    export RBD_POOL_NAME=Ceph_k3s_data
    export RGW_POOL_PREFIX=default
    ```

2. Use the output from #1 and enter it into your local machine bash environment (where-ever this repo is)

3. Run `infrastructure/configs/rook-ceph-external/cluster/setup-files/create-secrets.sh` to create the secret file. This will produce `secret.enc.yaml`. It will look like:
    ```
    ---
    apiVersion: v1
    data:
    admin-secret: !redact
    ceph-secret: !redact
    ceph-username: !redact
    cluster-name: !redact
    fsid: !redact
    mon-secret: !redact
    kind: Secret
    metadata:
    creationTimestamp: null
    name: rook-ceph-mon
    namespace: rook-ceph-external
    type: kubernetes.io/rook
    ---
    apiVersion: v1
    data:
    data: <nodeName>=<ip>:6789
    mapping: '{}'
    maxMonId: "2"
    kind: ConfigMap
    metadata:
    creationTimestamp: null
    name: rook-ceph-mon-endpoints
    namespace: rook-ceph-external
    ---
    apiVersion: v1
    data:
    userID: !redact
    userKey: !redact
    kind: Secret
    metadata:
    creationTimestamp: null
    name: rook-csi-rbd-node
    namespace: rook-ceph-external
    type: kubernetes.io/rook
    ---
    apiVersion: v1
    data:
    userID: !redact
    userKey: !redact
    kind: Secret
    metadata:
    creationTimestamp: null
    name: rook-csi-rbd-provisioner
    namespace: rook-ceph-external
    type: kubernetes.io/rook
    ---
    apiVersion: v1
    data:
    adminID: !redact
    adminKey: !redact
    kind: Secret
    metadata:
    creationTimestamp: null
    name: rook-csi-cephfs-node
    namespace: rook-ceph-external
    type: kubernetes.io/rook
    ---
    apiVersion: v1
    data:
    adminID: !redact
    adminKey: !redact
    kind: Secret
    metadata:
    creationTimestamp: null
    name: rook-csi-cephfs-provisioner
    namespace: rook-ceph-external
    type: kubernetes.io/rook
    ```

4. You can encrypt `secret.enc.yaml` with your SOPS solution; although I use 1password to capture this information. To achieve this it requires manual translation:
    * The values are base64 encoded, you will need to decode them for example with terminal `echo secretstring | base64 -d`
    * Translate in an `external-secrets.io` manifest, note the `target.template.type: kubernetes.io/rook` to specify the secret type.
    ```
    ---
    apiVersion: external-secrets.io/v1
    kind: ExternalSecret
    metadata:
    name: rook-ceph-mon
    namespace: rook-ceph-external
    spec:
    secretStoreRef:
        kind: ClusterSecretStore
        name: onepassword-k3s
    target:
        creationPolicy: Owner
        template:
            type: kubernetes.io/rook
    data:
    - secretKey: admin-secret
        remoteRef:
        key: rook-ceph-mon
        property: admin-secret
    ```

5. Change the `maxMonId` to match the number of Monitors in your external cluster. This is derived from knowledge about [Ceph Monitors recovery](https://docs.mirantis.com/container-cloud/latest/operations-guide/tshoot/tshoot-ceph/ceph-mon-recovery.html), and I believe this also informs the values within Secret called `rook-ceph-config`
    ```
    ---
    apiVersion: v1
    data:
        data: prox1=10.10.10.34:6789
        mapping: '{}'
        maxMonId: "3"
        kind: ConfigMap
    metadata:
        creationTimestamp: null
        name: rook-ceph-mon-endpoints
        namespace: rook-ceph-external
    ```

## References
File construction is largely based on research from [rook/deploy/examples](https://github.com/rook/rook/tree/master/deploy/examples), specifically:
* [cluster-external.yaml](https://github.com/rook/rook/blob/master/deploy/examples/cluster-external.yaml)
* [cluster-external-management.yaml](https://github.com/rook/rook/blob/master/deploy/examples/cluster-external-management.yaml)
* [common-external.yaml](https://github.com/rook/rook/blob/master/deploy/examples/common-external.yaml)
* [import-external-cluster.sh script](https://github.com/rook/rook/blob/master/deploy/examples/import-external-cluster.sh)

These files were taken and converted into a working example by [dcplaya/home-ops (Drew)](https://github.com/dcplaya/home-ops), using his [rook-ceph-external](https://github.com/dcplaya/home-ops/tree/main/k8s/clusters/cluster-1/manifests/rook-ceph-external)
* [secrets.yaml](https://github.com/dcplaya/home-ops/blob/main/k8s/clusters/cluster-1/manifests/rook-ceph-external/cluster/secret.sops.yaml)
* [ceph-common-external.yaml](https://github.com/dcplaya/home-ops/blob/main/k8s/clusters/cluster-1/manifests/rook-ceph-external/cluster/ceph-common-external.yaml)
* [ceph-cluster.yaml](https://github.com/dcplaya/home-ops/blob/main/k8s/clusters/cluster-1/manifests/rook-ceph-external/cluster/ceph-cluster.yaml)
* [storage-class.yaml](https://github.com/dcplaya/home-ops/blob/main/k8s/clusters/cluster-1/manifests/rook-ceph-external/cluster/storage-class.yaml)
* [ceph-monitor.yaml](https://github.com/dcplaya/home-ops/blob/main/k8s/clusters/cluster-1/manifests/rook-ceph-external/cluster/ceph-monitor.yaml)

Rooks [External Storage Cluster](https://rook.io/docs/rook/latest/CRDs/Cluster/external-cluster/) guide for getting ceph settings

Funky Penguin's guide (internal Ceph Cluster):
* [Rook Ceph / CephFS - Operator](https://geek-cookbook.funkypenguin.co.nz/kubernetes/persistence/rook-ceph/operator/)
* [Rook Ceph / CephFS - Cluster](https://geek-cookbook.funkypenguin.co.nz/kubernetes/persistence/rook-ceph/cluster/)


[Rook and External Ceph Clusters](https://github.com/rook/rook/blob/master/design/ceph/ceph-external-cluster.md)
[rook-ceph (Operator) Helm Chart](https://github.com/rook/rook/tree/master/deploy/charts/rook-ceph)
[rook-ceph-cluster Helm Chart](https://github.com/rook/rook/tree/master/deploy/charts/rook-ceph-cluster)
[import-external-cluster.sh script](https://github.com/rook/rook/blob/master/deploy/examples/import-external-cluster.sh)
[Configuring Rook with External Ceph](https://medium.com/techlogs/configuring-rook-with-external-ceph-6b4b49626112)
[ROOK CephCluster CRD](https://rook.io/docs/rook/v1.10/CRDs/Cluster/ceph-cluster-crd/)
[ROOK Ceph Cluster Helm Chart](https://rook.io/docs/rook/v1.11/Helm-Charts/ceph-cluster-chart/)
[Shared Ceph Filesystem](https://github.com/rook/rook/blob/master/Documentation/CRDs/Shared-Filesystem/ceph-filesystem-crd.md#filesystem-settings)


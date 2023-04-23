See this [home-ops](https://github.com/dcplaya/home-ops/blob/main/k8s/clusters/cluster-1/manifests/rook-ceph-external/cluster/README.md) repo for further background

Make sure prometheus endpoint is enabled in proxmox via 

```bash
ceph mgr module enable prometheus
```

To get the secrets, run
```bash
python3 create-external-cluster-resources.py \
--rbd-data-pool-name ceph_ssd \
--namespace rook-ceph-external \
--format bash
 ```

Run `create-secrets.sh` to create the secret file.
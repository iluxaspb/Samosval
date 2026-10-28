// The owner enabled online work after publishing the dedicated test Rules.
// Only an active administrator may initialize a missing switch. Explicit false wins.
export async function onlinePolicy(host) {
  if (!host.transaction) return false;
  const ref = host.workspace.collection("tabelNextMeta").doc("config");
  let policy = await ref.get();
  if (!policy.exists && host.session().role === "admin") {
    await host.transaction(async (tx) => {
      const current = await tx.get(ref);
      if (!current.exists) tx.set(ref, { enabled: true, schema: 1 });
    });
    policy = await ref.get({ source: "server" });
  }
  return (
    policy.exists &&
    policy.data().enabled === true &&
    policy.data().schema === 1
  );
}

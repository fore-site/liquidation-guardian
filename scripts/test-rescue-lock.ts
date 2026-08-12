export {}; // make this file a module so top-level await is valid

type LockStore = { acquireRescueLock(chainId: string, wallet: string, owner: string): Promise<boolean>; releaseRescueLock(chainId: string, wallet: string, owner: string): Promise<void> };

class FakeLockStore implements LockStore {
  private owner: string | null = null;
  async acquireRescueLock(_chainId: string, _wallet: string, owner: string): Promise<boolean> { if (this.owner) return false; this.owner = owner; return true; }
  async releaseRescueLock(_chainId: string, _wallet: string, owner: string): Promise<void> { if (this.owner === owner) this.owner = null; }
}

const store = new FakeLockStore();
const first = await store.acquireRescueLock("11155111", "0xabc", "one");
const second = await store.acquireRescueLock("11155111", "0xabc", "two");
await store.releaseRescueLock("11155111", "0xabc", "two");
const stillHeld = !(await store.acquireRescueLock("11155111", "0xabc", "three"));
await store.releaseRescueLock("11155111", "0xabc", "one");
const released = await store.acquireRescueLock("11155111", "0xabc", "three");
if (!first || second || !stillHeld || !released) throw new Error("rescue lock semantics failed");
console.log("Rescue lock tests passed.");

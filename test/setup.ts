// The library handle deliberately lives for the isolate's lifetime. Initialize
// it before test resource snapshots; individual connections still close in tests.
import { initializeNative } from '../src/native/mod.ts';
initializeNative();

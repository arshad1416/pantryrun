import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { linkingConfig } from '../src/navigation/deepLinks';

// Execute the installed native hook with a deterministic native event source.
// This exercises the library defaults that PantryRun previously replaced with
// no-ops, without requiring a simulator or replacing its URL lifecycle logic.
function nativeLinkingHarness(initialURL: string | null) {
  const cleanups: Array<() => void> = [];
  let urlListener: ((event: { url: string }) => void) | undefined;
  const remove = jest.fn(() => { urlListener = undefined; });
  const getInitialURL = jest.fn(async () => initialURL);
  const addEventListener = jest.fn((_event, listener) => {
    urlListener = listener;
    return { remove };
  });
  const navigation = {
    dispatch: jest.fn(), resetRoot: jest.fn(),
  };
  const react = {
    useRef: (value: unknown) => ({ current: value }),
    useCallback: (callback: Function) => callback,
    useEffect: (effect: () => void | (() => void)) => {
      const cleanup = effect();
      if (cleanup) cleanups.push(cleanup);
    },
  };
  // Independent path parser: validate the application route table used by the
  // real native hook, keeping the event and initial-state assertions separate.
  const getStateFromPath = (routePath: string, config: any) => {
    const [pathname, query] = routePath.split('?');
    const screen = Object.entries(config.screens).find(([, route]: any) =>
      typeof route === 'string'
        ? route === pathname
        : route.path === pathname || route.alias?.includes(pathname));
    if (!screen) return undefined;
    return { routes: [{ name: screen[0], params: Object.fromEntries(new URLSearchParams(query)) }] };
  };
  const libraryRoot = path.dirname(require.resolve('@react-navigation/native/package.json'));
  function loadSource(filename: string): any {
    const source = fs.readFileSync(filename, 'utf8');
    const exports: any = {};
    const compiled = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText;
    const requireFixture = (id: string): any => {
      if (id === 'react') return react;
      if (id === 'react-native') return { Linking: { getInitialURL, addEventListener }, Platform: { OS: 'ios' } };
      if (id === '@react-navigation/core') return {
        useNavigationIndependentTree: () => false,
        getStateFromPath,
        getActionFromState: (state: any) => ({ type: 'NAVIGATE', payload: state.routes[0] }),
      };
      if (id === 'escape-string-regexp') return (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (id.startsWith('.')) {
        const base = path.resolve(path.dirname(filename), id);
        const dependency = [`${base}.ts`, `${base}.tsx`].find(fs.existsSync);
        if (!dependency) throw new Error(`Missing native-linking dependency: ${id}`);
        return loadSource(dependency);
      }
      throw new Error(`Unexpected native-linking dependency: ${id}`);
    };
    new Function('require', 'exports', compiled)(requireFixture, exports);
    return exports;
  }
  const { useLinking } = loadSource(path.join(libraryRoot, 'src/useLinking.native.tsx'));
  const hook = useLinking({ current: navigation }, linkingConfig, jest.fn());
  return { hook, navigation, getInitialURL, addEventListener, remove,
    emit: (url: string) => urlListener?.({ url }),
    dispose: () => cleanups.reverse().forEach((cleanup) => cleanup()),
  };
}

describe('native deep-link lifecycle', () => {
  it('reads a cold Settings URL through the native platform default', async () => {
    const harness = nativeLinkingHarness('groceryapp://settings');
    expect(await harness.hook.getInitialState()).toEqual({ routes: [{ name: 'Settings', params: {} }] });
    expect(harness.getInitialURL).toHaveBeenCalledTimes(1);
    harness.dispose();
  });

  it('routes live invite URLs and preserves the token on Pairing', () => {
    const harness = nativeLinkingHarness(null);
    harness.emit('groceryapp://invite?token=synthetic%20invite');
    expect(harness.navigation.dispatch).toHaveBeenCalledWith({
      type: 'NAVIGATE', payload: { name: 'Pairing', params: { token: 'synthetic invite' } },
    });
    expect(harness.addEventListener).toHaveBeenCalledWith('url', expect.any(Function));
    harness.dispose();
  });

  it('removes the native URL listener on unmount', () => {
    const harness = nativeLinkingHarness(null);
    harness.dispose();
    harness.emit('groceryapp://settings');
    expect(harness.remove).toHaveBeenCalledTimes(1);
    expect(harness.navigation.dispatch).not.toHaveBeenCalled();
  });

  it('ignores a URL outside the supported prefixes', () => {
    const harness = nativeLinkingHarness(null);
    harness.emit('https://unrelated.example/settings');
    expect(harness.navigation.dispatch).not.toHaveBeenCalled();
    harness.dispose();
  });
});

// Entry point - bypasses Expo.fx that crashes on RN 0.85.3 + Hermes.
// Global error handler + webcrypto globals: must stay the first import (imports
// are hoisted, so it evaluates before every other module, including App).
import './src/error-handler';

import './src/polyfills/textEncoding';

import { AppRegistry } from 'react-native';
import App from './App';

AppRegistry.registerComponent('main', () => App);


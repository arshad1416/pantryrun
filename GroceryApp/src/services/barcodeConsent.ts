/**
 * Barcode-lookup consent gate.
 *
 * Naming a scanned product requires sending the barcode number — and nothing
 * else — to the Open Food Facts public database (world.openfoodfacts.org),
 * and, in builds configured with a USDA API key (EXPO_PUBLIC_USDA_API_KEY),
 * to USDA FoodData Central (api.nal.usda.gov) when Open Food Facts has no
 * match. The disclosure names every service the build can contact.
 * That network call must not happen before the user has agreed to it, so both
 * scanner entry points (Home scan tab, Add-Item sheet) call
 * ensureBarcodeLookupConsent() before opening the camera.
 *
 * Mirrors the flyer-scan pricing opt-in pattern in GroceryListScreen: keep the
 * feature discoverable, present the disclosure inline on first use, and
 * persist the choice in settings (`barcodeScanningEnabled`, default false).
 * lookupProduct() re-checks the setting as defence-in-depth, so no future
 * caller can reach the network without it.
 */

import { Alert } from 'react-native';
import { getSettings, setBarcodeScanningEnabled } from '../config/settings';

/** The consent text, naming each food database this build sends barcodes to. */
export function barcodeLookupDisclosure(): string {
  const usda = !!process.env.EXPO_PUBLIC_USDA_API_KEY;
  const databases = usda
    ? 'the Open Food Facts public food database and, when it has no match, the USDA FoodData Central database'
    : 'the Open Food Facts public food database';
  return `To name scanned products, PantryRun sends the barcode number — and nothing else — to ${databases}. No account, device ID, or list data is sent with it. You can turn this off anytime in Settings.`;
}

export async function ensureBarcodeLookupConsent(): Promise<boolean> {
  if (getSettings().barcodeScanningEnabled ?? false) return true;

  return new Promise<boolean>((resolve) => {
    Alert.alert(
      'Turn on barcode lookups?',
      barcodeLookupDisclosure(),
      [
        { text: 'Not now', style: 'cancel', onPress: () => resolve(false) },
        {
          text: 'Turn on & scan',
          onPress: async () => {
            try {
              await setBarcodeScanningEnabled(true);
              resolve(true);
            } catch {
              resolve(false);
            }
          },
        },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

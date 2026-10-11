import { Linking, Platform } from 'react-native';
import { getSettings } from '../config/settings';

export async function navigateToStore(storeName: string): Promise<void> {
  const settings = getSettings();
  // No postal code set: search the store name alone and let the maps app use
  // the phone's location, rather than sending everyone to Niagara (L0R).
  const fsa = settings.flippFsa?.trim();
  const query = encodeURIComponent(fsa ? `${storeName} ${fsa}` : storeName);
  const pref = settings.navigationApp;

  let url: string;
  if (pref === 'google' || (pref !== 'apple' && Platform.OS === 'android')) {
    url = `https://www.google.com/maps/search/?api=1&query=${query}`;
  } else {
    const googleUrl = `comgooglemaps://?q=${query}`;
    const canOpen = await Linking.canOpenURL(googleUrl);
    url = canOpen ? googleUrl : `https://maps.apple.com/?q=${query}`;
  }

  try {
    await Linking.openURL(url);
  } catch {
    await Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${query}`);
  }
}

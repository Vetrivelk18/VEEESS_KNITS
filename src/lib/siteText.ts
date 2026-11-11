// Shop texts for the static pages (D50): what admins saved at the last publish, with defaults for the rest.
import saved from '../data/site-text.json';
import { resolveSiteText } from '../../shared/siteText';

export const siteText = resolveSiteText(saved as Record<string, unknown>);
/** Text split at the admin's line breaks, for rendering with <br />. */
export const lines = (key: string): string[] => (siteText[key] ?? '').split('\n');

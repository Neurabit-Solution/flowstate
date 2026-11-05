// Pure so it can be unit tested without Electron.

export type MediaRequest = {
  permission: string;
  mediaTypes?: readonly string[];
  requestingUrl: string;
};

/** Camera only, video only, and only for our own bundled page. Everything else is denied. */
export function isCameraRequestAllowed(req: MediaRequest, pageUrl: string): boolean {
  const types = req.mediaTypes ?? [];
  const videoOnly = types.length === 1 && types[0] === 'video';
  return req.permission === 'media' && videoOnly && req.requestingUrl === pageUrl;
}

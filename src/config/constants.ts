
import path from 'path';

export const TEMP_UPLOAD_DIR = path.join(process.cwd(), 'tmp', 'project_uploads');
// SITES_DIR is no longer the primary deployment target for the deployProject action,
// but might be used by other parts of the application or for local serving if needed.
// Firebase Storage is now used for deployed sites.
export const SITES_DIR = path.join(process.cwd(), 'public', 'sites');

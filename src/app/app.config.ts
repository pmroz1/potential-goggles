import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';

import { EditorBackend, TauriEditorBackend } from './core/editor-backend';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    { provide: EditorBackend, useClass: TauriEditorBackend },
  ],
};

import { ACKNOWLEDGEMENTS, creditLine } from '@calendar/core/acknowledgements';
import { app, Menu, type MenuItemConstructorOptions } from 'electron';
import { showSettingsWindow } from './windows.ts';

/**
 * The application menu. Electron's default one has no Settings item, and
 * the `appMenu` role cannot take one, so the app menu is spelled out:
 * Settings… sits below About with ⌘, where macOS apps keep it. As a menu
 * accelerator it works from any window and with none open — the app keeps
 * running windowless. The other menus are the stock roles.
 */
export const installApplicationMenu = (): void => {
  // About Solunivo credits what the app ships and downloads; the licence
  // texts ride beside it in Resources (THIRD_PARTY_NOTICES.md).
  app.setAboutPanelOptions({
    credits: [
      ...ACKNOWLEDGEMENTS.map(creditLine),
      '',
      'The licence texts: THIRD_PARTY_NOTICES.md in the app’s Resources.',
    ].join('\n'),
  });
  const template: Array<MenuItemConstructorOptions> = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          accelerator: 'CommandOrControl+,',
          click: () => showSettingsWindow(),
          label: 'Settings…',
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
};

/**
 * English catalogue — the source of truth.
 *
 * Keys are `area.screen.element`. Placeholders are `{name}` and are replaced
 * verbatim, so a translation may reorder them freely.
 */
export const en = {
  // Shell
  'nav.search': 'Search',
  'nav.servers': 'My servers',
  'nav.admin': 'Administration',
  'nav.account': 'My account',
  'nav.signOut': 'Sign out',
  'nav.language': 'Language',

  'common.save': 'Save',
  'common.saving': 'Saving…',
  'common.cancel': 'Cancel',
  'common.delete': 'Delete',
  'common.create': 'Create',
  'common.close': 'Close',
  'common.confirm': 'Confirm',
  'common.loading': 'Loading…',
  'common.never': 'never',
  'common.unlimited': 'unlimited',
  'common.copy': 'copy',
  'common.copied': 'copied',
  'common.retry': 'Try again',
  'common.search': 'Search',
  'common.none': 'None',

  // Sign in
  'login.title': 'Sign in',
  'login.identifier': 'Email or username',
  'login.password': 'Password',
  'login.submit': 'Sign in',
  'login.submitting': 'Signing in…',
  'login.totpTitle': 'Two-factor code',
  'login.totpHint': 'Six digits from your authenticator app.',
  'login.totpSubmit': 'Verify',
  'login.failed': 'Sign-in failed.',

  // Two-factor requirement banner
  'twoFactor.required':
    'This instance requires two-factor authentication. Turn it on to keep your servers protected.',
  'twoFactor.enable': 'Turn on',

  // Dashboard
  'dashboard.title': 'My servers',
  'dashboard.subtitle': '{count} server(s)',
  'dashboard.empty': 'No servers yet',
  'dashboard.emptyHint': 'Servers you own or have been given access to appear here.',
  'dashboard.searchPlaceholder': 'Name, identifier or port',

  // Server states
  'state.offline': 'Offline',
  'state.starting': 'Starting',
  'state.running': 'Online',
  'state.stopping': 'Stopping',
  'state.installing': 'Installing',
  'state.install_failed': 'Install failed',
  'state.restoring_backup': 'Restoring',
  'state.suspended': 'Suspended',
  'state.missing': 'Missing',

  // Server tabs
  'tab.console': 'Console',
  'tab.files': 'Files',
  'tab.databases': 'Databases',
  'tab.backups': 'Backups',
  'tab.schedules': 'Schedules',
  'tab.subusers': 'Users',
  'tab.network': 'Network',
  'tab.startup': 'Startup',
  'tab.webhooks': 'Notifications',
  'tab.settings': 'Settings',
  'tab.activity': 'Activity',

  // Console
  'console.start': 'Start',
  'console.restart': 'Restart',
  'console.stop': 'Stop',
  'console.kill': 'Kill',
  'console.killConfirm':
    'Killing the server cuts the process without saving. Data loss, even map corruption, is possible. Continue?',
  'console.commandPlaceholder': 'Type a command, then Enter…',
  'console.commandDenied': 'You do not have permission to send commands.',
  'console.address': 'Address',
  'console.uptime': 'Uptime',
  'console.cpu': 'Processor',
  'console.memory': 'Memory',
  'console.disk': 'Disk',
  'console.networkIn': 'Network (inbound)',
  'console.networkOut': 'Network (outbound)',
  'console.chartCpu': 'Processor',
  'console.chartMemory': 'Memory',
  'console.chartNetwork': 'Network',
  'console.chartInbound': 'inbound',
  'console.chartOutbound': 'outbound',
  'console.copyAddress': 'Copy {value}',

  // Duration and size
  'unit.offline': 'offline',
  'unit.bytes': 'B',
  'unit.kib': 'KiB',
  'unit.mib': 'MiB',
  'unit.gib': 'GiB',
  'unit.tib': 'TiB',

  // Account
  'account.title': 'My account',
  'account.admin': 'administrator',
  'account.passwordTitle': 'Password',
  'account.currentPassword': 'Current password',
  'account.newPassword': 'New password',
  'account.passwordHint': 'Twelve characters minimum.',
  'account.confirmation': 'Confirmation',
  'account.mismatch': 'The two entries differ.',
  'account.changePassword': 'Change password',
  'account.passwordChanged':
    'Password changed. Your other sessions were closed, and SFTP now uses this new password.',
  'account.twoFactorTitle': 'Two-factor authentication',
  'account.twoFactorIntro':
    'A second factor protects your account even if your password leaks. It also protects SFTP, which uses the same credentials.',
  'account.twoFactorEnable': 'Turn on two-factor authentication',
  'account.twoFactorSecretIntro':
    'Add this secret to your authenticator app, then enter the code it shows.',
  'account.twoFactorCode': 'Six-digit code',
  'account.twoFactorActivate': 'Turn on',
  'account.recoveryIntro':
    'Write down these recovery codes: they will never be shown again. Each one works once, if you lose your phone.',
  'account.languageTitle': 'Language',
  'account.languageHint':
    'Applies to this browser only. Other people using this panel keep their own choice.',
  'account.languageAuto': 'Instance default ({name})',

  // API keys
  'apiKeys.title': 'API keys',
  'apiKeys.create': 'Create a key',
  'apiKeys.empty':
    'No keys. An API key drives your servers from a script or a bot, with your own access.',
  'apiKeys.memo': 'What is this key for?',
  'apiKeys.memoHint': 'This is what tells you which one to revoke.',
  'apiKeys.scope': 'Scope',
  'apiKeys.scopeRead': 'Read',
  'apiKeys.scopeReadHint': 'List servers, files and backups.',
  'apiKeys.scopeWrite': 'Write',
  'apiKeys.scopeWriteHint': 'Act: start, stop, write a file, take a backup.',
  'apiKeys.scopeAdmin': 'Administration',
  'apiKeys.scopeAdminHint': 'Reach the instance administration routes.',
  'apiKeys.allowedIps': 'Allowed addresses',
  'apiKeys.allowedIpsHint': 'Optional, comma separated. Left empty, no restriction applies.',
  'apiKeys.issued': 'Copy this key now: it will never be shown again.',
  'apiKeys.revoke': 'Revoke',
  'apiKeys.revokeConfirm': 'Revoke the key “{memo}”?',
  'apiKeys.lastUsed': 'last used on {date}',
  'apiKeys.neverUsed': 'never used',

  // Administration
  'admin.overview': 'Overview',
  'admin.settings': 'Settings',
  'admin.nodes': 'Nodes',
  'admin.servers': 'Servers',
  'admin.users': 'Users',
  'admin.databaseHosts': 'Database hosts',
  'admin.templates': 'Templates',
  'admin.sectionAdministration': 'Administration',
  'admin.sectionOperations': 'Operations',
  'admin.sectionCatalogue': 'Catalogue',

  'adminSettings.title': 'Settings',
  'adminSettings.subtitle': 'How the panel presents itself, sends mail and behaves.',
  'adminSettings.tabGeneral': 'General',
  'adminSettings.tabMail': 'Mail',
  'adminSettings.tabAdvanced': 'Advanced',
  'adminSettings.unsaved': 'Unsaved changes.',
  'adminSettings.saved': 'Settings saved.',
  'adminSettings.panelName': 'Instance name',
  'adminSettings.panelNameHint': 'Shown in the interface and in the mail it sends.',
  'adminSettings.defaultLanguage': 'Default language',
  'adminSettings.defaultLanguageHint':
    'Used for anyone who has not picked a language, and on the sign-in page.',
  'adminSettings.twoFactor': 'Two-factor authentication',
  'adminSettings.twoFactorNone': 'Optional',
  'adminSettings.twoFactorAdmins': 'Administrators',
  'adminSettings.twoFactorAll': 'Everyone',
  'adminSettings.twoFactorHint':
    'Affected accounts keep access to their account page to turn it on — a second factor cannot be demanded before letting someone set it up.',
  'adminSettings.smtpTitle': 'SMTP server',
  'adminSettings.smtpIntro':
    'Without it, creating an account sends nothing: an administrator has to hand over a password themselves.',
  'adminSettings.mailOn': 'Sending enabled',
  'adminSettings.mailOff': 'Sending disabled',
  'adminSettings.mailHost': 'Host',
  'adminSettings.mailPort': 'Port',
  'adminSettings.mailEncryption': 'Encryption',
  'adminSettings.mailUsername': 'Username',
  'adminSettings.mailUsernameHint': 'Empty for a server without authentication.',
  'adminSettings.mailPassword': 'Password',
  'adminSettings.mailPasswordKept': 'Stored. Leave empty to keep it.',
  'adminSettings.mailPasswordNew': 'Stored encrypted, never shown again.',
  'adminSettings.mailFrom': 'From address',
  'adminSettings.mailFromName': 'From name',
  'adminSettings.testTitle': 'Test message',
  'adminSettings.testIntro': 'The test uses the saved settings: save before trying it.',
  'adminSettings.testRecipient': 'Recipient',
  'adminSettings.testSend': 'Send',
  'adminSettings.testSending': 'Sending…',
  'adminSettings.testSent':
    'Message sent to {address}. If it does not arrive, check the spam folder.',
  'adminSettings.nodeTimeout': 'Node timeout (ms)',
  'adminSettings.nodeTimeoutHint':
    'Past this, a daemon is treated as unreachable. Raise it for a distant machine.',
  'adminSettings.retention': 'Activity log retention (days)',
  'adminSettings.retentionHint':
    '0 keeps everything. The log says who did what: pruning it is a decision, not a default.',
  'adminSettings.envNote':
    'The public URL, the application secret and the database stay in the .env file. That secret encrypts node tokens and SQL passwords: changing it by accident makes all of them unreadable.',

  // Users administration
  'adminUsers.title': 'Users',
  'adminUsers.count': '{count} account(s)',
  'adminUsers.email': 'Email address',
  'adminUsers.username': 'Username',
  'adminUsers.usernameHint': 'Also used as the SFTP username.',
  'adminUsers.password': 'Password',
  'adminUsers.passwordHint':
    'Leave empty to send a link by mail: that is the better option, a password chosen here travels through a channel you do not control.',
  'adminUsers.passwordPlaceholder': 'link sent by mail',
  'adminUsers.role': 'Role',
  'adminUsers.roleHint': 'An administrator reaches every server on the instance.',
  'adminUsers.roleUser': 'User',
  'adminUsers.roleAdmin': 'Administrator',
  'adminUsers.invitationSent': 'Account created. A link to choose a password was sent to {email}.',
  'adminUsers.invitationNotSent':
    'Account created. No mail was sent: set up an SMTP server in the settings, or hand over the password yourself.',
  'adminUsers.resend': 'Resend invitation',
  'adminUsers.resent': 'Invitation sent again.',
  'adminUsers.resendFailed': 'No SMTP server configured: nothing could be sent.',
  'adminUsers.you': 'you',
  'adminUsers.lastLogin': 'Last sign-in',
  'adminUsers.twoFactor': '2FA',
  'adminUsers.twoFactorOn': 'on',

  // Password setup
  'setup.title': 'Choose your password',
  'setup.intro': 'This link works once. It protects access to your servers and to SFTP.',
  'setup.incomplete':
    'This link is incomplete. Open it from the mail you received, without retyping it.',
  'setup.done': 'Password saved. You can now sign in.',
  'setup.goToLogin': 'Go to sign-in',
} as const;

export type MessageKey = keyof typeof en;
export type Messages = Record<MessageKey, string>;

// 'unverified' = a credential is saved but the connector cannot yet prove it
// works (no live API check wired). It is deliberately NOT 'connected' — the
// board never claims a connection it hasn't verified.
export type ConnectorState = 'connected' | 'unverified' | 'not_configured' | 'error';

export type ConnectorKind =
  | 'email'
  | 'calendar'
  | 'slack'
  | 'payments'
  | 'notion'
  | 'brain'
  | 'social'
  | 'crm'
  | 'ads'
  | 'creative'
  | 'knowledge'
  | 'local'
  | 'web'
  | 'orchestration';

export type ConnectorStatus = {
  id: string;
  name: string;
  kind: ConnectorKind;
  state: ConnectorState;
  detail: string;
  meta?: Record<string, string | number>;
};

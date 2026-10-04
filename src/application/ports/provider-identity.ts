// Ponto de extensão da tarefa 34. A identidade deve vir de um IdP externo, nunca do body da aposta.
export interface ProviderIdentity {
  subject: string;
  providerId: string;
  scopes: readonly string[];
}
export interface ProviderIdentityPort {
  // A implementação futura validará assinatura, issuer, audience e expiração via OIDC/JWKS.
  authenticate(authorization: string | undefined): Promise<ProviderIdentity>;
}
export const PROVIDER_IDENTITY = Symbol('PROVIDER_IDENTITY');

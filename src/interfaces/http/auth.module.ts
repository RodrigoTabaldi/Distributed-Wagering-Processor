import {
  Injectable,
  Module,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Inject } from '@nestjs/common';

export const PUBLIC_ENDPOINT = 'dwp:public';
export const Public = () => SetMetadata(PUBLIC_ENDPOINT, true);

@Injectable()
export class DemoAuthGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}
  canActivate(context: ExecutionContext): boolean {
    // Health permanece público quando este guard for substituído por integração OIDC.
    if (
      this.reflector.getAllAndOverride<boolean>(PUBLIC_ENDPOINT, [
        context.getHandler(),
        context.getClass(),
      ])
    )
      return true;
    // Decisão explícita do desafio: sem autenticação nesta versão local. Isto NÃO valida uma identidade.
    // A versão com IdP deve usar ProviderIdentityPort e autorizar o providerId e o acesso à wallet.
    return true;
  }
}
@Module({ providers: [{ provide: APP_GUARD, useClass: DemoAuthGuard }] })
export class AuthModule {}

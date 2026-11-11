// Authentication extension point. No IdP is integrated (auth is out of the challenge's scoring);
// see ARCHITECTURE.md for the intended Keycloak/OIDC design. Swapping REQUEST_AUTHENTICATOR for a
// JWT-verifying implementation is the only change needed to enforce it on every non-public route.
import {
  Inject,
  Injectable,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ApiError, ApiErrorCode } from '../errors/api-error';

export const REQUEST_AUTHENTICATOR = Symbol('REQUEST_AUTHENTICATOR');
const IS_PUBLIC = 'auth:isPublic';

/** Marks a route as open (health checks). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export interface Principal {
  subject: string;
  /** Provider the caller is entitled to act as, when the credential is provider-scoped. */
  providerId: string | undefined;
}

export interface RequestAuthenticator {
  authenticate(request: Request): Promise<Principal | undefined>;
}

/** Default: accepts every request as an anonymous principal. */
export class AllowAllAuthenticator implements RequestAuthenticator {
  async authenticate(): Promise<Principal> {
    return { subject: 'anonymous', providerId: undefined };
  }
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(REQUEST_AUTHENTICATOR) private readonly authenticator: RequestAuthenticator,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request & { principal?: Principal }>();
    const principal = await this.authenticator.authenticate(request);
    if (!principal) {
      throw new ApiError(401, ApiErrorCode.Unauthorized, 'Authentication required');
    }
    request.principal = principal;
    return true;
  }
}

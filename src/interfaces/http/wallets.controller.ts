import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { WAGERING_QUERIES, type WageringQueries } from '../../application/ports/queries';
import { OpenWallet } from '../../application/wallets/open-wallet';
import { ReconcileWallet } from '../../application/wallets/reconcile-wallet';
import { CorrelationId } from './correlation-id';
import { ApiError, ApiErrorCode } from './errors/api-error';
import { LedgerCursor } from './ledger-cursor';
import { ledgerQuerySchema, openWalletSchema, parse } from '../contracts';

@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly openWallet: OpenWallet,
    private readonly reconcileWallet: ReconcileWallet,
    @Inject(WAGERING_QUERIES) private readonly queries: WageringQueries,
  ) {}

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown, @CorrelationId() correlationId: string) {
    const command = parse(openWalletSchema, body);
    const result = await this.openWallet.execute({ ...command, correlationId });
    if (result.outcome === 'ALREADY_EXISTS') {
      throw new ApiError(
        409,
        ApiErrorCode.WalletAlreadyExists,
        'A wallet already exists for this player and currency',
      );
    }
    return result.wallet;
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string) {
    const wallet = await this.queries.wallet(walletId);
    if (!wallet) throw ApiError.notFound('Wallet');
    return wallet;
  }

  @Get(':walletId/ledger')
  async ledger(@Param('walletId') walletId: string, @Query() query: unknown) {
    const { cursor, limit } = parse(ledgerQuerySchema, query);
    const afterSequence = cursor ? LedgerCursor.decode(walletId, cursor) : undefined;

    const page = await this.queries.ledger(walletId, { afterSequence, limit });
    if (!page) throw ApiError.notFound('Wallet');

    const last = page.items.at(-1);
    return {
      items: page.items.map(({ sequence, ...entry }) => entry),
      nextCursor: page.hasMore && last ? LedgerCursor.encode(walletId, last.sequence) : null,
    };
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconcile(@Param('walletId') walletId: string) {
    const report = await this.reconcileWallet.execute(walletId);
    if (!report) throw ApiError.notFound('Wallet');
    return report;
  }
}

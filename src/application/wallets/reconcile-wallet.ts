import type { MoneyProps } from '../../domain/money/money';
import type { Telemetry } from '../ports/system';
import type { UnitOfWork } from '../ports/unit-of-work';

export interface ReconciliationReport {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

/**
 * Compares the materialized balance with the balance rebuilt from the ledger. Divergences are
 * reported (log + metric) and flagged in the response — never corrected silently.
 */
export class ReconcileWallet {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly telemetry: Telemetry,
  ) {}

  async execute(walletId: string): Promise<ReconciliationReport | undefined> {
    const snapshot = await this.unitOfWork.run((repositories) =>
      repositories.ledger.snapshot(walletId),
    );
    if (!snapshot) return undefined;

    const difference = snapshot.storedBalance.subtract(snapshot.calculatedBalance);
    const report: ReconciliationReport = {
      walletId,
      storedBalance: snapshot.storedBalance.toJSON(),
      calculatedBalance: snapshot.calculatedBalance.toJSON(),
      difference: difference.toJSON(),
      consistent: difference.isZero(),
      checkedEntries: snapshot.entries,
    };

    if (!report.consistent) {
      this.telemetry.walletDivergenceDetected({
        walletId,
        storedBalance: report.storedBalance.amount,
        calculatedBalance: report.calculatedBalance.amount,
        difference: report.difference.amount,
        checkedEntries: report.checkedEntries,
      });
    }
    return report;
  }
}

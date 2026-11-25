import { Actor, Batch } from '../domain/types';
import { WorkflowRules } from '../domain/workflow';
import { ConflictError, NotFoundError } from '../errors';
import { IActorRepo } from '../repository/interfaces';

/**
 * Validates who takes a lot next and returns their id — null when an ADMIN
 * deliberately leaves it unclaimed.
 *
 * Who may take it: anyone whose role records one of the steps that can come
 * next after `fromPos` (optional steps may be skipped, so up to and
 * including the next required one), or — with `sameStageAllowed` — someone
 * working the step the lot is at now (e.g. a merge at one collector handed to
 * another). ADMIN can always take it.
 */
export async function resolveNextAssignee(
  actorRepo: IActorRepo,
  actor: Actor,
  rules: WorkflowRules,
  fromPos: number,
  assignNextTo: string | undefined,
  options: { sameStageAllowed?: boolean; batch?: Pick<Batch, 'metadata'> } = {},
): Promise<string | null> {
  if (!assignNextTo) {
    // A merged/split/transformed lot stays with whoever made it unless handed on.
    if (options.sameStageAllowed) return actor.id;
    if (actor.role === 'ADMIN') return null;
    // Whoever can also do what comes next (the mill drying then milling) simply keeps it.
    if (rules.rolesForNext(fromPos, options.batch).has(actor.role)) return actor.id;
    throw new ConflictError('You must designate who handles the next stage before completing this one');
  }

  const nextActor = await actorRepo.findById(assignNextTo);
  if (!nextActor || nextActor.tenantId !== actor.tenantId) throw new NotFoundError('Assigned actor not found');
  if (!nextActor.isActive) throw new ConflictError('Assigned actor account is inactive');
  if (nextActor.role === 'ADMIN') return nextActor.id;

  const candidates = rules.nextCandidates(fromPos, options.batch);
  const current = options.sameStageAllowed ? rules.steps.find((s) => s.position === fromPos) : undefined;
  const allowed = new Set([...candidates, ...(current ? [current] : [])].flatMap((s) => s.roles));
  if (!allowed.has(nextActor.role)) {
    const stages = (candidates.length ? candidates : current ? [current] : []).map((s) => s.stage).join(' / ') || 'none';
    throw new ConflictError(`${nextActor.role} cannot handle stage ${stages}`);
  }
  return nextActor.id;
}

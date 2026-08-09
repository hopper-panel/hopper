import type { FormEvent, ReactNode } from 'react';
import { useTranslation } from '../i18n';
import { ApiError } from '../lib/api';
import { Modal } from './Modal';
import { Alert, Button } from './ui';

/**
 * A form in a dialog, which is how this panel creates things.
 *
 * Six screens already did it by hand and four did it inline instead — the
 * administration's users, nodes, servers and template groups unfolded a panel
 * above their list, turned the button that opened it into "Cancel", and pushed
 * every row down the page so the field to fill in appeared under the button
 * just clicked. That was never a decision; it was four pages written before
 * `Modal` was reached for.
 *
 * Two things are baked in here so that no page has to remember them.
 *
 * **The submit button belongs to a form it is not inside.** `Modal` renders the
 * footer as a sibling of the body, so a plain `type="submit"` there submits
 * nothing at all; it carries `form={formId}` instead. Constraint validation
 * still runs — a button associated by that attribute is a submit button of
 * that form and goes through the same submission algorithm — so `required`,
 * `pattern` and `minLength` on the fields keep working from out there. The
 * `disabled` prop is for the emptiness the caller would rather refuse quietly
 * than answer with a browser bubble.
 *
 * **The dialog is unmounted rather than hidden**, and that is the caller's
 * side of the bargain: render it behind a condition, never with an `open`
 * prop. Its form state then lives in a component that does not exist while the
 * dialog is closed, so a dialog abandoned halfway through and reopened is
 * empty — with no effect to write and no field to forget to clear.
 */
export function FormDialog({
  title,
  formId,
  onClose,
  onSubmit,
  submit,
  submitting,
  pending,
  disabled,
  error,
  children,
}: {
  title: string;
  /** Ties the footer's button to the body's form; unique on the page. */
  formId: string;
  onClose: () => void;
  onSubmit: () => void;
  submit: string;
  /** Shown on the button while the request is in flight. */
  submitting: string;
  pending: boolean;
  /** True while the form has not been filled in enough to send. */
  disabled?: boolean;
  /** Rendered above the fields; anything that is not an `ApiError` is ignored. */
  error?: unknown;
  children: ReactNode;
}) {
  const { t } = useTranslation();

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    onSubmit();
  }

  return (
    <Modal
      open
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            type="submit"
            form={formId}
            variant="primary"
            disabled={pending || disabled === true}
          >
            {pending ? submitting : submit}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={handleSubmit} className="space-y-4">
        {/* Inside the body rather than above the fields' container, so a
            refusal scrolls with the form it is about on a short screen. */}
        {error instanceof ApiError ? <Alert>{error.message}</Alert> : null}
        {children}
      </form>
    </Modal>
  );
}

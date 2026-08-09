// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TranslationProvider } from '../i18n';
import { ApiError } from '../lib/api';
import { FormDialog } from './FormDialog';
import { Field, Input } from './ui';

/**
 * The two things every create form in the administration now depends on.
 *
 * Tested here rather than five times over on the pages that use it, because
 * both are properties of this component and neither is visible from a page:
 * the submit button lives outside the `<form>` it submits, and the dialog's
 * state has to be gone once it closes. A page that got either wrong would look
 * fine until somebody pressed the button or reopened the box.
 */

function Harness({ onSubmit, error }: { onSubmit?: () => void; error?: unknown }) {
  const [open, setOpen] = useState(false);

  return (
    <TranslationProvider>
      <button type="button" onClick={() => setOpen(true)}>
        open
      </button>

      {/* Behind a condition, with the fields' state inside the component that
          the condition mounts. That is the contract FormDialog documents, and
          the arrangement the pages using it all follow — a harness holding the
          state itself would test the opposite of what is claimed. */}
      {open ? (
        <ThingDialog onClose={() => setOpen(false)} onSubmit={onSubmit} error={error} />
      ) : null}
    </TranslationProvider>
  );
}

function ThingDialog({
  onClose,
  onSubmit,
  error,
}: {
  onClose: () => void;
  onSubmit?: () => void;
  error?: unknown;
}) {
  const [name, setName] = useState('');

  return (
    <FormDialog
      title="Create a thing"
      formId="thing"
      onClose={onClose}
      onSubmit={() => onSubmit?.()}
      submit="Create"
      submitting="Creating…"
      pending={false}
      disabled={name.trim() === ''}
      error={error}
    >
      <Field label="Name">
        <Input value={name} onChange={(event) => setName(event.target.value)} />
      </Field>
    </FormDialog>
  );
}

afterEach(cleanup);

describe('FormDialog', () => {
  /**
   * `Modal` renders the footer as a sibling of the body, so the button is not
   * inside the form it submits. It works through `form="thing"`, and if that
   * attribute is ever dropped the button becomes inert — which looks exactly
   * like a request that failed silently.
   */
  it('submits a form the button is not inside', () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole('button', { name: 'open' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'a thing' } });

    const submit = screen.getByRole('button', { name: 'Create' });
    expect(submit.getAttribute('form')).toBe('thing');

    fireEvent.submit(screen.getByRole('dialog').querySelector('form') as HTMLFormElement);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('refuses an empty form without a browser bubble', () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: 'open' }));

    expect(screen.getByRole('button', { name: 'Create' })).toHaveProperty('disabled', true);
  });

  /**
   * The caller's half of the bargain, asserted here because this is where it is
   * documented: the dialog is rendered behind a condition, so its state lives
   * in a component that does not exist while it is closed.
   */
  it('forgets what was typed once it is closed', () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: 'open' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'half typed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'open' }));
    expect(screen.getByRole('textbox')).toHaveProperty('value', '');
  });

  it('shows what the API refused, and ignores anything that is not a refusal', () => {
    const { unmount } = render(<Harness error={new ApiError(409, 'That name is taken.')} />);

    fireEvent.click(screen.getByRole('button', { name: 'open' }));
    expect(screen.getByText('That name is taken.')).toBeTruthy();

    unmount();

    // A network error or an aborted fetch is not something to paste at the top
    // of a form: it has no message the operator can act on.
    render(<Harness error={new Error('fetch failed')} />);
    fireEvent.click(screen.getByRole('button', { name: 'open' }));
    expect(screen.queryByText('fetch failed')).toBeNull();
  });
});

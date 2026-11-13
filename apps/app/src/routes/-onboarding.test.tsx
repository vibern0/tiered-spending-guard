import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { useVaultMock, navigateMock } = vi.hoisted(() => ({
  useVaultMock: vi.fn(),
  navigateMock: vi.fn(),
}));

vi.mock("@/lib/vault-store", () => ({ useVault: useVaultMock }));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
  Link: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...props}>{children}</a>
  ),
  Navigate: () => null,
  useNavigate: () => navigateMock,
  useRouterState: () => ({ location: { pathname: "/onboarding" } }),
}));

import { OnboardingPage } from "./onboarding";

const base = {
  state: {
    policy: { firstSignerDaily: 1_000_000n, instantDaily: 3_000_000n, delaySeconds: 120n },
    onboarding: { rehearsed: false },
    safe: "",
    secondSignerName: "Second signer",
    network: "Ethereum Sepolia (testnet)",
  },
  setup: {
    primaryCredentialId: "primary",
    secondaryCredentialId: "secondary",
    secondaryAuthenticator: "cross-platform",
    distinctSecondary: true,
    provisioning: "provisioning",
    credentialRebind: { required: false, primary: "ready", secondary: "ready" },
    submissionIds: [],
  },
  loading: false,
  registerPrimary: vi.fn(),
  registerSecondary: vi.fn(),
  retryProvisioning: vi.fn(),
  rebindPrimary: vi.fn(),
  rebindSecondary: vi.fn(),
  finishSetup: vi.fn(),
  startNewVault: vi.fn().mockResolvedValue(undefined),
};

describe("automatic provisioning onboarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useVaultMock.mockReturnValue(base);
  });

  it("shows automatic progress without plan, approval, or provision buttons", () => {
    render(<OnboardingPage />);
    expect(screen.getByText(/Provisioning and verifying/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Create unsigned deployment plan/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /operator approval/i })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Provision reviewed vault/i }),
    ).not.toBeInTheDocument();
  });

  it("shows automatic recovery messages and references without another signer prompt", () => {
    useVaultMock.mockReturnValue({
      ...base,
      setup: {
        ...base.setup,
        provisioningError: "Setup is recovering automatically. Reference: resume-123.",
      },
    });
    const { rerender } = render(<OnboardingPage />);
    expect(screen.getByRole("status")).toHaveTextContent("resume-123");
    expect(screen.queryByRole("button", { name: /Check setup status/i })).not.toBeInTheDocument();
    useVaultMock.mockReturnValue({
      ...base,
      setup: {
        ...base.setup,
        provisioning: "failed",
        provisioningError: "Vault setup stopped safely. Reference: stopped-123.",
      },
    });
    rerender(<OnboardingPage />);
    expect(screen.getByRole("alert")).toHaveTextContent("stopped-123");
    expect(screen.getByRole("button", { name: /Check setup status/i })).toBeEnabled();
    expect(base.registerPrimary).not.toHaveBeenCalled();
    expect(base.registerSecondary).not.toHaveBeenCalled();
  });

  it("offers only explicit retry after a fail-closed automatic attempt", () => {
    useVaultMock.mockReturnValue({ ...base, setup: { ...base.setup, provisioning: "failed" } });
    render(<OnboardingPage />);
    fireEvent.click(screen.getByRole("button", { name: /Check setup status/i }));
    expect(base.retryProvisioning).toHaveBeenCalledTimes(1);
  });
});

it("offers separate sign-in and account creation before registration", async () => {
  const signIn = vi.fn().mockResolvedValue(undefined);
  const createAccount = vi.fn().mockResolvedValue(undefined);
  useVaultMock.mockReturnValue({
    ...base,
    sessionManaged: true,
    authenticated: false,
    accountId: undefined,
    signIn,
    createAccount,
    setup: {
      ...base.setup,
      primaryCredentialId: undefined,
      secondaryCredentialId: undefined,
      provisioning: "registering",
    },
  });
  render(<OnboardingPage />);
  expect(screen.queryByRole("button", { name: "Register first signer" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Sign in with passkey" }));
  await waitFor(() => expect(signIn).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "Create account" }));
  await waitFor(() => expect(createAccount).toHaveBeenCalledTimes(1));
});

it("explains that the prompt after first registration verifies the same first key", () => {
  useVaultMock.mockReturnValue({
    ...base,
    sessionManaged: true,
    authenticated: false,
    accountId: "unfinished",
    setup: { ...base.setup, secondaryCredentialId: undefined },
  });
  render(<OnboardingPage />);
  expect(screen.getByRole("heading", { name: "Verify your first passkey" })).toBeInTheDocument();
  expect(screen.getByText(/same first passkey.*second signer/i)).toBeInTheDocument();
});

it("does not request generic second-key recovery after first-key account sign-in", () => {
  useVaultMock.mockReturnValue({
    ...base,
    sessionManaged: true,
    authenticated: true,
    accountId: "a",
    signOut: vi.fn(),
    setup: {
      ...base.setup,
      provisioning: "provisioned",
      credentialRebind: { required: false, primary: "ready", secondary: "required" },
    },
  });
  render(<OnboardingPage />);
  expect(screen.queryByRole("button", { name: /Verify second signer/i })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
});

it("resumes a bound recovery plan without offering a replacement second registration", () => {
  useVaultMock.mockReturnValue({
    ...base,
    sessionManaged: true,
    authenticated: true,
    accountId: "legacy",
    signOut: vi.fn(),
    setup: {
      ...base.setup,
      secondaryCredentialId: undefined,
      reviewedPlanBound: true,
      provisioning: "provisioning",
    },
  });
  render(<OnboardingPage />);
  expect(screen.getByText(/Provisioning and verifying/i)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Register second signer" })).not.toBeInTheDocument();
});

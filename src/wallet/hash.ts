import { createHash, timingSafeEqual } from "node:crypto";

/** Values hashed by the authorization server to sign the finish redirect (GNAP section 4.2.3). */
export type InteractionHashInput = {
  readonly clientNonce: string;
  readonly interactNonce: string;
  readonly interactRef: string;
  readonly authServerUrl: string;
};

/** Computes and checks the `hash` the authorization server adds to the finish redirect. */
export class LoginHash {
  private constructor() {}

  /** Returns the GNAP interaction hash as unpadded base64url. Never throws. */
  public static compute(input: InteractionHashInput): string {
    return LoginHash.digest(input).toString("base64url");
  }

  /** True when `receivedHash` matches; accepts base64url (GNAP) and padded base64 (Open Payments docs sample). Never throws. */
  public static isValid(input: InteractionHashInput, receivedHash: string): boolean {
    const digest = LoginHash.digest(input);
    return [digest.toString("base64url"), digest.toString("base64")].some((expected) =>
      LoginHash.isEqual(expected, receivedHash),
    );
  }

  private static digest(input: InteractionHashInput): Buffer {
    const base = [input.clientNonce, input.interactNonce, input.interactRef, input.authServerUrl];
    return createHash("sha256").update(base.join("\n")).digest();
  }

  private static isEqual(left: string, right: string): boolean {
    const leftBytes = Buffer.from(left);
    const rightBytes = Buffer.from(right);
    return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
  }
}

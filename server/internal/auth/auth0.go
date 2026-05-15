package auth

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/MicahParks/keyfunc/v3"
	"github.com/golang-jwt/jwt/v5"
)

// Claims is the subset of the Auth0 access token we use.
type Claims struct {
	jwt.RegisteredClaims
}

type Verifier struct {
	kf       keyfunc.Keyfunc
	issuer   string
	audience string
}

func NewVerifier(ctx context.Context, domain, audience string) (*Verifier, error) {
	if domain == "" || audience == "" {
		return nil, errors.New("auth: domain and audience required")
	}
	jwksURL := fmt.Sprintf("https://%s/.well-known/jwks.json", domain)
	kf, err := keyfunc.NewDefaultCtx(ctx, []string{jwksURL})
	if err != nil {
		return nil, fmt.Errorf("auth: JWKS init: %w", err)
	}
	return &Verifier{
		kf:       kf,
		issuer:   "https://" + domain + "/",
		audience: audience,
	}, nil
}

// Verify parses, validates signature, iss, aud, exp. Returns the subject claim.
func (v *Verifier) Verify(token string) (string, error) {
	parsed, err := jwt.ParseWithClaims(token, &Claims{}, v.kf.Keyfunc,
		jwt.WithValidMethods([]string{"RS256"}),
		jwt.WithIssuer(v.issuer),
		jwt.WithAudience(v.audience),
		jwt.WithExpirationRequired(),
		jwt.WithLeeway(30*time.Second),
	)
	if err != nil {
		return "", err
	}
	c, ok := parsed.Claims.(*Claims)
	if !ok || !parsed.Valid {
		return "", errors.New("auth: invalid token")
	}
	if c.Subject == "" {
		return "", errors.New("auth: missing sub")
	}
	return c.Subject, nil
}

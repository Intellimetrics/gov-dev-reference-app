package gov.agency.intake;

import javax.ejb.Stateless;

@Stateless
public class ReferralLookupBean {
  public String lookup(String id) { return id; }
}
